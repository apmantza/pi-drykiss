import type {
	ExtensionContext,
	AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
	buildBucketedSynthesisPrompt,
	buildSynthesisPrompt,
} from "./prompt-builder.js";
import { saveReview } from "./persist.js";
import {
	createFallbackSynthesis,
	parseSynthesis,
	type SynthesisResult,
} from "./types.js";
import type {
	ReviewJobState,
	RetryLensOnModelError,
	SubagentResult,
} from "./review-lifecycle-types.js";
import { resolveModel, runLensSubagent } from "./subagent-runner.js";
import { isModelError } from "./model-selector.js";
import { LOG_PREFIX } from "./constants.js";
import {
	logAutoreviewEvent,
	logAutoreviewError,
	tokenUsageDetails,
} from "./logger.js";

interface SynthesisRunnerOptions {
	readonly retryOnModelError: RetryLensOnModelError;
	readonly onComplete: (job: ReviewJobState) => void;
}

function lensReviewsFor(
	job: ReviewJobState,
): Array<{ lens: string; rawOutput: string }> {
	return job.lenses.map((lens) => ({
		lens,
		rawOutput: job.states.get(lens)?.rawOutput ?? "ERROR: missing lens state",
	}));
}

async function buildPrompt(
	cwd: string,
	lensReviews: Array<{ lens: string; rawOutput: string }>,
): Promise<{ systemPrompt: string; userPrompt: string }> {
	try {
		return await buildBucketedSynthesisPrompt(lensReviews);
	} catch (err) {
		logAutoreviewError("synthesis.bucket_prompt_error", err, {
			lensReviews: lensReviews.length,
		});
		console.warn(
			"%s Bucketed synthesis prompt failed, falling back to raw:",
			LOG_PREFIX,
			err,
		);
		return buildSynthesisPrompt(cwd, lensReviews);
	}
}

function replaceSynthesisSession(
	job: ReviewJobState,
	session: AgentSession | undefined,
): void {
	if (!session) return;
	if (job.synthesisSession && job.synthesisSession !== session) {
		try {
			job.synthesisSession.dispose();
		} catch {
			/* ignore dispose errors */
		}
	}
	job.synthesisSession = session;
}

function synthesisResultFrom(result: SubagentResult): SynthesisResult {
	if (result.errorMessage) {
		return createFallbackSynthesis(`Synthesis failed: ${result.errorMessage}`);
	}
	return parseSynthesis(result.text || "{}");
}

/** Execute synthesis, persist its result, and notify the manager. */
export async function runSynthesis(
	ctx: ExtensionContext,
	cwd: string,
	job: ReviewJobState,
	options: SynthesisRunnerOptions,
): Promise<void> {
	logAutoreviewEvent("synthesis.start", {
		jobId: job.id,
		lenses: job.lenses,
	});
	const lensReviews = lensReviewsFor(job);
	const { systemPrompt, userPrompt } = await buildPrompt(cwd, lensReviews);
	logAutoreviewEvent("synthesis.prompt_ready", {
		jobId: job.id,
		systemChars: systemPrompt.length,
		userChars: userPrompt.length,
	});
	let model;
	try {
		model = await resolveModel(ctx, "synthesis");
	} catch (err) {
		logAutoreviewError("synthesis.model_error", err, { jobId: job.id });
		throw err;
	}
	logAutoreviewEvent("synthesis.model_resolved", {
		jobId: job.id,
		model: model.name,
		provider: model.provider,
	});

	try {
		logAutoreviewEvent("synthesis.model_call_start", {
			jobId: job.id,
			model: model.name,
		});
		const result = await runLensSubagent(
			ctx,
			cwd,
			model,
			systemPrompt,
			userPrompt,
			"synthesis",
		);
		replaceSynthesisSession(job, result.session);
		logAutoreviewEvent("synthesis.model_complete", {
			jobId: job.id,
			model: result.modelName,
			provider: result.provider,
			responseChars: result.text.length,
			...(tokenUsageDetails(result.usage) ?? {}),
			error: result.errorMessage,
		});

		let finalResult = result;
		if (result.errorMessage && isModelError(result.errorMessage)) {
			logAutoreviewEvent("synthesis.retry_start", {
				jobId: job.id,
				error: result.errorMessage,
			});
			const retryResult = await options.retryOnModelError(
				ctx,
				model,
				job.synthesisSession,
				"synthesis",
				(modelForRetry) =>
					runLensSubagent(
						ctx,
						cwd,
						modelForRetry,
						systemPrompt,
						userPrompt,
						"synthesis",
					),
				{ error: result.errorMessage, lens: "synthesis" },
			);
			if (retryResult) {
				logAutoreviewEvent("synthesis.retry_complete", {
					jobId: job.id,
					model: retryResult.modelName,
					provider: retryResult.provider,
					responseChars: retryResult.text.length,
					...(tokenUsageDetails(retryResult.usage) ?? {}),
					error: retryResult.errorMessage,
				});
				replaceSynthesisSession(job, retryResult.session);
				finalResult = retryResult;
			}
		}

		job.synthesisResult = synthesisResultFrom(finalResult);
		job.synthesisStatus = finalResult.errorMessage ? "error" : "done";
		logAutoreviewEvent("synthesis.parsed", {
			jobId: job.id,
			status: job.synthesisStatus,
			findings: job.synthesisResult.findings.length,
			verdict: job.synthesisResult.verdict,
			healthScore: job.synthesisResult.healthScore,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logAutoreviewError("synthesis.error", err, { jobId: job.id });
		job.synthesisStatus = "error";
		job.synthesisResult = createFallbackSynthesis(
			`Synthesis failed: ${message}`,
		);
	}

	job.overallStatus =
		job.lenses.some((lens) => job.states.get(lens)?.status === "error") ||
		job.synthesisStatus === "error"
			? "error"
			: "done";
	job.completedAt = Date.now();

	if (job.synthesisResult) {
		try {
			job.reviewPath = await saveReview(job.files, job.synthesisResult);
			logAutoreviewEvent("synthesis.persisted", {
				jobId: job.id,
				reviewPath: job.reviewPath,
			});
		} catch (err) {
			logAutoreviewError("synthesis.persist_error", err, { jobId: job.id });
			/* Non-fatal: review result is still valid without persistence */
		}
	}

	logAutoreviewEvent("synthesis.complete", {
		jobId: job.id,
		status: job.synthesisStatus,
		overallStatus: job.overallStatus,
	});
	options.onComplete(job);
}
