import type { Model, Api } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ReviewLens } from "./types.js";
import { parseFindingsJson } from "./parse-findings.js";
import { saveSessionLog } from "./persist.js";
import type { SubagentResult } from "./subagent-runner.js";
import { runLensSubagent } from "./subagent-runner.js";
import { LOG_PREFIX } from "./constants.js";
import { isModelError } from "./model-selector.js";
import type { ReviewJob, LensState } from "./review-manager.js";

export interface LensExecutionTask {
	readonly jobId: string;
	readonly lens: ReviewLens;
	readonly model: Model<Api>;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly signal: AbortSignal;
	readonly onStreamUpdate: () => void;
}

export type RetryLensOnModelError = (
	ctx: ExtensionContext,
	failedModel: Model<Api>,
	failedSession: AgentSession | undefined,
	taskLabel: string,
	run: (model: Model<Api>) => Promise<SubagentResult>,
	options?: { error?: unknown; lens?: string },
) => Promise<SubagentResult | null>;

export interface LensRunnerOptions {
	readonly getJob: (jobId: string) => ReviewJob | undefined;
	readonly onUpdate?: (job: ReviewJob) => void;
	readonly retryOnModelError: RetryLensOnModelError;
	readonly onAllLensesDone: (
		ctx: ExtensionContext,
		cwd: string,
		job: ReviewJob,
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
	onUpdate: ((job: ReviewJob) => void) | undefined,
	job: ReviewJob,
): void {
	try {
		onUpdate?.(job);
	} catch {
		/* callbacks must not affect review execution */
	}
}

async function saveLog(
	job: ReviewJob,
	state: LensState,
	lens: ReviewLens,
	session: AgentSession | undefined,
): Promise<void> {
	try {
		state.logPath = await saveSessionLog(job.id, lens, session);
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
	await saveLog(job, state, task.lens, result.session);

	if (result.errorMessage && isModelError(result.errorMessage)) {
		const retryResult = await options.retryOnModelError(
			ctx,
			task.model,
			state.session,
			task.lens,
			run,
			{ error: result.errorMessage, lens: task.lens },
		);
		if (retryResult) {
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
		setLensError(state, result.errorMessage);
	} else {
		applySuccessfulOutput(state, result.text, task.lens);
	}

	notify(options.onUpdate, job);
	const allDone = job.lenses.every((lens) => {
		const lensState = job.states.get(lens);
		return lensState?.status === "done" || lensState?.status === "error";
	});
	if (allDone) await options.onAllLensesDone(ctx, cwd, job);
	options.drain(ctx, pi, cwd);
}

function setLensError(state: LensState, message: string): void {
	state.status = "error";
	state.errorMessage = message;
	state.rawOutput = `ERROR: ${message}`;
}
