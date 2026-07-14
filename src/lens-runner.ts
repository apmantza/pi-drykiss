import type { Model, Api } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ReviewLens } from "./types.js";
import { parseFindingsJson } from "./parse-findings.js";
import { saveSessionLog } from "./persist.js";
import { runLensSubagent } from "./subagent-runner.js";
import { LOG_PREFIX } from "./constants.js";
import { isModelError } from "./model-selector.js";
import type {
	LensExecutionTask,
	LensState,
	RetryLensOnModelError,
	ReviewJobState,
} from "./review-lifecycle-types.js";
import {
	logAutoreviewEvent,
	logAutoreviewError,
	tokenUsageDetails,
} from "./logger.js";

interface LensRunnerOptions {
	readonly getJob: (jobId: string) => ReviewJobState | undefined;
	readonly onUpdate?: (job: ReviewJobState) => void;
	readonly retryOnModelError: RetryLensOnModelError;
	readonly onAllLensesDone: (
		ctx: ExtensionContext,
		cwd: string,
		job: ReviewJobState,
	) => Promise<void>;
	readonly drain: (
		ctx: ExtensionContext,
		pi: ExtensionAPI,
		cwd: string,
	) => void;
}

function applySuccessfulOutput(
	state: LensState,
	text: string,
	lens: ReviewLens,
): void {
	state.status = "done";
	const rawOutput = text || "[]";
	const { findings, parseError } = parseFindingsJson(rawOutput, lens);
	if (parseError) {
		console.warn(
			`${LOG_PREFIX} ${parseError} Raw output preserved for inspection.`,
		);
		state.status = "error";
		state.errorMessage = parseError;
		state.rawOutput = rawOutput;
		state.findingsCount = 0;
		return;
	}
	state.rawOutput = JSON.stringify(findings, null, 2);
	state.findingsCount = findings.length;
}

function notify(
	onUpdate: ((job: ReviewJobState) => void) | undefined,
	job: ReviewJobState,
): void {
	try {
		onUpdate?.(job);
	} catch {
		/* callbacks must not affect review execution */
	}
}

async function saveLog(
	job: ReviewJobState,
	state: LensState,
	lens: ReviewLens,
	session: AgentSession | undefined,
): Promise<void> {
	try {
		state.logPath = await saveSessionLog(job.id, lens, session);
		logAutoreviewEvent("lens.session_persisted", {
			jobId: job.id,
			lens,
			logPath: state.logPath,
		});
	} catch (err) {
		console.warn(
			"%s Failed to save session log for %s: %s",
			LOG_PREFIX,
			lens,
			err instanceof Error ? err.message : String(err),
		);
	}
}

/** Execute one lens and hand completed jobs back to the manager. */
export async function runLens(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	cwd: string,
	task: LensExecutionTask,
	options: LensRunnerOptions,
): Promise<void> {
	const job = options.getJob(task.jobId);
	if (!job) return;

	const state = job.states.get(task.lens);
	if (!state) return;
	state.status = "running";
	state.startedAt = Date.now();
	logAutoreviewEvent("lens.start", {
		jobId: task.jobId,
		lens: task.lens,
		model: task.model.name,
		provider: task.model.provider,
	});
	notify(options.onUpdate, job);

	const streamUpdate = () => {
		state.streamingText = "streaming...";
		task.onStreamUpdate();
	};
	const run = (model: Model<Api>) =>
		runLensSubagent(
			ctx,
			cwd,
			model,
			task.systemPrompt,
			task.userPrompt,
			task.lens,
			task.signal,
			streamUpdate,
		);

	const result = await run(task.model);
	state.durationMs = result.durationMs;
	state.session = result.session;
	logAutoreviewEvent("lens.model_complete", {
		jobId: task.jobId,
		lens: task.lens,
		model: result.modelName,
		provider: result.provider,
		durationMs: result.durationMs,
		responseChars: result.text.length,
		...(tokenUsageDetails(result.usage) ?? {}),
		error: result.errorMessage,
	});
	await saveLog(job, state, task.lens, result.session);

	if (result.errorMessage && isModelError(result.errorMessage)) {
		logAutoreviewEvent("lens.retry_start", {
			jobId: task.jobId,
			lens: task.lens,
			error: result.errorMessage,
		});
		const retryResult = await options.retryOnModelError(
			ctx,
			task.model,
			state.session,
			task.lens,
			run,
			{ error: result.errorMessage, lens: task.lens },
		);
		if (retryResult) {
			logAutoreviewEvent("lens.retry_complete", {
				jobId: task.jobId,
				lens: task.lens,
				model: retryResult.modelName,
				provider: retryResult.provider,
				...(tokenUsageDetails(retryResult.usage) ?? {}),
				error: retryResult.errorMessage,
			});
			state.session = retryResult.session;
			state.modelName = retryResult.modelName;
			if (retryResult.provider) state.provider = retryResult.provider;
			await saveLog(job, state, task.lens, retryResult.session);
			if (retryResult.errorMessage) {
				setLensError(state, retryResult.errorMessage);
			} else {
				applySuccessfulOutput(state, retryResult.text, task.lens);
			}
		} else {
			setLensError(state, result.errorMessage);
			state.session = undefined;
		}
	} else if (result.errorMessage) {
		logAutoreviewError("lens.error", result.errorMessage, {
			jobId: task.jobId,
			lens: task.lens,
		});
		setLensError(state, result.errorMessage);
	} else {
		applySuccessfulOutput(state, result.text, task.lens);
	}

	logAutoreviewEvent("lens.complete", {
		jobId: task.jobId,
		lens: task.lens,
		status: state.status,
		findings: state.findingsCount,
		durationMs: state.durationMs,
		error: state.errorMessage,
	});
	notify(options.onUpdate, job);
	const allDone = job.lenses.every((lens) => {
		const lensState = job.states.get(lens);
		return lensState?.status === "done" || lensState?.status === "error";
	});
	if (allDone) {
		logAutoreviewEvent("lenses.complete", {
			jobId: task.jobId,
			lenses: job.lenses,
			errors: job.lenses.filter(
				(lens) => job.states.get(lens)?.status === "error",
			).length,
		});
		await options.onAllLensesDone(ctx, cwd, job);
	}
	options.drain(ctx, pi, cwd);
}

function setLensError(state: LensState, message: string): void {
	state.status = "error";
	state.errorMessage = message;
	state.rawOutput = `ERROR: ${message}`;
}
