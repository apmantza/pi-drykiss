import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionContext, AgentSession } from "@earendil-works/pi-coding-agent";
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
import type { SubagentResult } from "./subagent-runner.js";
import { resolveModel, runLensSubagent } from "./subagent-runner.js";
import { isModelError } from "./model-selector.js";
import { LOG_PREFIX } from "./constants.js";
import type { ReviewJob } from "./review-manager.js";
import type { RetryLensOnModelError } from "./lens-runner.js";

export interface SynthesisRunnerOptions {
	readonly retryOnModelError: RetryLensOnModelError;
	readonly onComplete: (job: ReviewJob) => void;
}

function lensReviewsFor(job: ReviewJob): Array<{ lens: string; rawOutput: string }> {
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
		console.warn(
			"%s Bucketed synthesis prompt failed, falling back to raw:",
			LOG_PREFIX,
			err,
		);
		return buildSynthesisPrompt(cwd, lensReviews);
	}
}

function replaceSynthesisSession(job: ReviewJob, session: AgentSession | undefined): void {
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
	job: ReviewJob,
	options: SynthesisRunnerOptions,
): Promise<void> {
	const lensReviews = lensReviewsFor(job);
	const { systemPrompt, userPrompt } = await buildPrompt(cwd, lensReviews);
	const model = await resolveModel(ctx, "synthesis");

	try {
		const result = await runLensSubagent(
			ctx,
			cwd,
			model,
			systemPrompt,
			userPrompt,
			"synthesis",
		);
		replaceSynthesisSession(job, result.session);

		let finalResult = result;
		if (result.errorMessage && isModelError(result.errorMessage)) {
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
				replaceSynthesisSession(job, retryResult.session);
				finalResult = retryResult;
			}
		}

		job.synthesisResult = synthesisResultFrom(finalResult);
		job.synthesisStatus = finalResult.errorMessage ? "error" : "done";
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		job.synthesisStatus = "error";
		job.synthesisResult = createFallbackSynthesis(`Synthesis failed: ${message}`);
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
		} catch {
			/* Non-fatal: review result is still valid without persistence */
		}
	}

	options.onComplete(job);
}
