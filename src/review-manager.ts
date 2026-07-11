import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ReviewLens, ChangedFile, SynthesisResult } from "./types.js";
import { LENS_NAMES, createFallbackSynthesis } from "./types.js";
import { buildReviewPrompts } from "./prompt-builder.js";
import { appendHistory, loadHistory } from "./persist.js";
import type { SubagentResult } from "./subagent-runner.js";
import {
	runLens as runLensTask,
	type LensExecutionTask,
} from "./lens-runner.js";
import { runSynthesis as runSynthesisTask } from "./synthesis-runner.js";
import { findModelByHint } from "./llm.js";
import { selectModelOnError } from "./model-selector.js";
import { LOG_PREFIX } from "./constants.js";

/**
 * Load the most recent health score for a given review mode from history.
 * Returns undefined when no prior record exists.
 */
async function computePrevScore(mode?: string): Promise<number | undefined> {
	if (!mode) return undefined;
	const history = await loadHistory();
	// Iterate in reverse — newest entries are appended at the end
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].mode === mode) return history[i].score;
	}
	return undefined;
}
import {
	buildReviewResult,
	getFindingIdentity,
	type ReviewResult,
	type ReviewResultTarget,
} from "./review-result.js";
import { loadRejections } from "./rejections.js";
import { runValidator, selectFindingsForValidation } from "./validator.js";

const CONCURRENCY = 3;
const DEFAULT_PROGRESS_INTERVAL_MS = 1000;

export type LensStatus = "queued" | "running" | "done" | "error";

export interface LensState {
	status: LensStatus;
	modelName: string;
	/**
	 * Provider id (e.g. "anthropic", "openai") for the model that ran this
	 * lens. Optional for backward compat with persisted reviews that
	 * pre-date the field; the widget falls back to the modelName alone
	 * when it's missing.
	 */
	provider?: string;
	durationMs: number;
	errorMessage?: string;
	findingsCount: number;
	rawOutput: string;
	/** Wall-clock timestamp when the lens transitioned to 'running'. Used by the widget to render a live elapsed timer. */
	startedAt?: number;
	/** Absolute path to the exported session transcript, set when the lens finishes. */
	logPath?: string;
	/** Live session object — kept alive for conversation viewing. */
	session?: AgentSession;
	/** Streaming text from the subagent (updated in real-time for live progress). */
	streamingText?: string;
}

export interface ReviewJob {
	id: string;
	files: string[];
	lenses: ReviewLens[];
	states: Map<ReviewLens, LensState>;
	synthesisStatus: "idle" | "running" | "done" | "error";
	synthesisResult?: SynthesisResult;
	/** Wall-clock timestamp when synthesis transitioned to 'running'. */
	synthesisStartedAt?: number;
	/** Session for the synthesis subagent, disposed on job cleanup. */
	synthesisSession?: AgentSession;
	/** Absolute path to the persisted synthesized review JSON, when saved. */
	reviewPath?: string;
	/** Post-processed result after validation, suppressions, ignores, and scoring. */
	finalResult?: ReviewResult;
	overallStatus: "queued" | "running" | "done" | "error";
	startedAt: number;
	completedAt?: number;
}

type OnReviewUpdate = (job: ReviewJob) => void;
type OnReviewComplete = (job: ReviewJob) => void;

function safeProgress(
	onProgress: ((job: ReviewJob) => void) | undefined,
	job: ReviewJob,
): void {
	try {
		onProgress?.(job);
	} catch {
		/* progress callbacks must not affect review execution */
	}
}

/**
 * Format a Map<file, diff> for the validator's user prompt. The
 * validator needs to see the actual code that was reviewed, not just
 * the findings, so it can verify whether a defect is triggered by a
 * concrete input or path. Pure; truncates each file's diff to keep
 * the prompt within the validator's context window.
 */
const VALIDATOR_DIFF_PER_FILE_BUDGET = 8_000;

function formatDiffsForValidator(diffs: Map<string, string>): string {
	if (diffs.size === 0) return "";
	const blocks: string[] = [];
	let total = 0;
	for (const [file, diff] of diffs) {
		const truncated =
			diff.length > VALIDATOR_DIFF_PER_FILE_BUDGET
				? `${diff.slice(0, VALIDATOR_DIFF_PER_FILE_BUDGET)}\n... (truncated)`
				: diff;
		blocks.push(`### ${file}\n\n${truncated}`);
		total += truncated.length;
		if (total > VALIDATOR_DIFF_PER_FILE_BUDGET * 3) {
			blocks.push(
				`\n... (remaining ${diffs.size - blocks.length} files omitted for context budget)`,
			);
			break;
		}
	}
	return `# Diff Under Review\n\n${blocks.join("\n\n")}`;
}

export class ReviewManager {
	private readonly jobs = new Map<string, ReviewJob>();
	private readonly onUpdate?: OnReviewUpdate;
	private readonly onComplete?: OnReviewComplete;

	/** Queue of lens review tasks waiting for a slot. */
	private taskQueue: {
		jobId: string;
		lens: ReviewLens;
		model: Model<Api>;
		systemPrompt: string;
		userPrompt: string;
		signal: AbortSignal;
		onStreamUpdate: () => void;
	}[] = [];

	/** Number of lens subagents currently running. */
	private runningCount = 0;

	/** Abort controllers per job for cancelling running sessions. */
	private readonly abortControllers = new Map<string, AbortController>();

	/** Locks to prevent concurrent synthesis runs for the same job. */
	private readonly synthesisLocks = new Set<string>();
	/**
	 * When a subagent fails with a model error (quota/auth/5xx), prompt the user to
	 * select a different model and retry. If autorouting is configured, skip the prompt
	 * and auto-select a free model instead.
	 *
	 * Returns the retry result on success (or on second failure), or null if the user
	 * cancelled model selection (caller should record the original error).
	 */
	private async retryOnModelError(
		ctx: ExtensionContext,
		failedModel: Model<Api>,
		failedSession: AgentSession | undefined,
		taskLabel: string,
		runFn: (model: Model<Api>) => Promise<SubagentResult>,
		options?: {
			/** Original error from the failed run, used for server-gated detection. */
			error?: unknown;
			/** Lens name — used to look up per-lens config on fallback. */
			lens?: string;
		},
	): Promise<SubagentResult | null> {
		const selected = await selectModelOnError(
			ctx,
			{ provider: failedModel.provider, id: failedModel.id },
			"Model Error",
			`Model "${failedModel.name}" failed.\n\nChoose a different model for ${taskLabel}:`,
			{ error: options?.error, lens: options?.lens },
		);
		if (!selected) {
			// User cancelled — dispose the failed session before returning
			if (failedSession) {
				try {
					failedSession.dispose();
				} catch {
					/* ignore dispose errors */
				}
			}
			return null;
		}

		ctx.ui.notify(`Switching to ${selected.name} for ${taskLabel}...`, "info");
		const retryResult = await runFn(selected);

		// Dispose the failed session (caller updates its own session ref)
		if (failedSession && failedSession !== retryResult.session) {
			try {
				failedSession.dispose();
			} catch {
				/* ignore */
			}
		}

		return retryResult;
	}

	constructor(onUpdate?: OnReviewUpdate, onComplete?: OnReviewComplete) {
		this.onUpdate = onUpdate;
		this.onComplete = onComplete;
	}

	async startReview(
		ctx: ExtensionContext,
		pi: ExtensionAPI,
		cwd: string,
		files: ChangedFile[],
		diffs: Map<string, string>,
		contents:
			| Map<string, { content: string; lineCount: number; truncated: boolean }>
			| undefined,
		projectIndex: import("./git-diff.js").ProjectIndexEntry[] | undefined,
		options: {
			model?: string;
			lenses?: ReviewLens[];
			activeConstraints?: string;
			commands?: { test?: string; lint?: string };
			pathInstructions?: readonly import("./config.js").ReviewPathInstruction[];
			/** Review mode (e.g. "pr", "full") — drives the posture context block. */
			mode?: string;
			/** Human-readable scope label injected into the posture block. */
			scopeLabel?: string;
		},
	): Promise<string> {
		const id = randomUUID().slice(0, 12);
		const lenses: ReviewLens[] = options.lenses ?? [...LENS_NAMES];

		// Resolve models
		const { resolveAllModels } = await import("./subagent-runner.js");
		let modelMap: Map<string, Model<Api>>;
		if (options.model) {
			const available = ctx.modelRegistry.getAvailable();
			const m = findModelByHint(available, options.model);
			if (!m) throw new Error(`Model "${options.model}" not found.`);
			modelMap = new Map(lenses.map((l) => [l, m]));
		} else {
			modelMap = await resolveAllModels(ctx, lenses);
		}

		// Build prompts
		const allPrompts = await buildReviewPrompts(cwd, files, diffs, "all", {
			contents,
			projectIndex,
			activeConstraints: options.activeConstraints,
			commands: options.commands,
			pathInstructions: options.pathInstructions,
			mode: options.mode,
			scopeLabel: options.scopeLabel,
		});
		const promptMap = new Map(allPrompts.map((p) => [p.lens, p]));

		// Initialize job
		const states = new Map<ReviewLens, LensState>();
		for (const lens of lenses) {
			const m = modelMap.get(lens);
			states.set(lens, {
				status: "queued",
				modelName: m?.name ?? "unknown",
				provider: m?.provider,
				durationMs: 0,
				findingsCount: 0,
				rawOutput: "[]",
			});
		}

		const job: ReviewJob = {
			id,
			files: files.map((f) => f.path),
			lenses,
			states,
			synthesisStatus: "idle",
			overallStatus: "running",
			startedAt: Date.now(),
		};
		this.jobs.set(id, job);

		// Create abort controller for this job
		const abortController = new AbortController();
		this.abortControllers.set(id, abortController);

		try {
			// Queue all lens tasks
			for (const lens of lenses) {
				const prompt = promptMap.get(lens);
				const model = modelMap.get(lens);
				if (!prompt || !model) {
					const s = states.get(lens)!;
					s.status = "error";
					s.errorMessage = !prompt
						? "No prompt generated"
						: "No model resolved";
					continue;
				}
				this.taskQueue.push({
					jobId: id,
					lens,
					model,
					systemPrompt: prompt.systemPrompt,
					userPrompt: prompt.userPrompt,
					signal: abortController.signal,
					onStreamUpdate: () => {
						// Notify UI on streaming updates for live progress
						try {
							this.onUpdate?.(job);
						} catch {
							/* don't let callback errors crash */
						}
					},
				});
			}

			// Start draining
			this.drain(ctx, pi, cwd).catch(this.logDrainFailure);
			return id;
		} catch (err) {
			// If anything fails after adding the job, clean up so no stale
			// job is left with lens states stuck at "queued".
			this.jobs.delete(id);
			this.abortControllers.delete(id);
			throw err;
		}
	}

	private async drain(ctx: ExtensionContext, pi: ExtensionAPI, cwd: string) {
		while (this.taskQueue.length > 0 && this.runningCount < CONCURRENCY) {
			const task = this.taskQueue.shift()!;
			this.runningCount++;
			this.runLens(ctx, pi, cwd, task)
				.catch((err) => {
					/* Mark the lens as errored when runLens throws unexpectedly.
					 * Note: the runningCount decrement + re-drain happen in
					 * .finally() below so the queue keeps processing even when
					 * a task rejects. */
					const job = this.jobs.get(task.jobId);
					if (job) {
						const state = job.states.get(task.lens);
						if (state) {
							state.status = "error";
							state.errorMessage =
								err instanceof Error ? err.message : String(err);
							state.session = undefined;
						}
						try {
							this.onUpdate?.(job);
						} catch {
							/* don't let callback errors crash the loop */
						}
					}
				})
				.finally(() => {
					/* Always decrement and re-drain, regardless of success or
					 * failure. This is the single source of truth for
					 * runningCount bookkeeping. Without the re-drain call here
					 * the queue would stall as soon as any task rejected. */
					this.runningCount--;
					this.drain(ctx, pi, cwd).catch(this.logDrainFailure);
				});
		}
	}

	private readonly logDrainFailure = (err: unknown): void => {
		console.warn("%s Review queue drain failed:", LOG_PREFIX, err);
	};

	private async runLens(
		ctx: ExtensionContext,
		pi: ExtensionAPI,
		cwd: string,
		task: LensExecutionTask,
	): Promise<void> {
		await runLensTask(ctx, pi, cwd, task, {
			getJob: (jobId) => this.jobs.get(jobId),
			onUpdate: this.onUpdate,
			retryOnModelError: this.retryOnModelError,
			onAllLensesDone: (runCtx, runCwd, job) =>
				this.handleAllLensesDone(runCtx, runCwd, job),
			drain: (runCtx, runPi, runCwd) => {
				this.drain(runCtx, runPi, runCwd).catch((err) => {
					console.warn("%s Review queue drain failed:", LOG_PREFIX, err);
				});
			},
		});
	}

	private async handleAllLensesDone(
		ctx: ExtensionContext,
		cwd: string,
		job: ReviewJob,
	): Promise<void> {
		if (this.synthesisLocks.has(job.id)) return;
		this.synthesisLocks.add(job.id);
		if (job.synthesisStatus !== "idle") {
			this.synthesisLocks.delete(job.id);
			return;
		}
		job.synthesisStatus = "running";
		job.synthesisStartedAt = Date.now();
		try {
			this.onUpdate?.(job);
		} catch {
			/* don't let callback errors crash the loop */
		}
		try {
			await this.runSynthesis(ctx, cwd, job);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			job.synthesisStatus = "error";
			job.synthesisResult = createFallbackSynthesis(
				`Synthesis crashed: ${msg}`,
			);
			job.overallStatus = "error";
			job.completedAt = Date.now();
			try {
				this.onComplete?.(job);
			} catch {
				/* ignore */
			}
		} finally {
			this.synthesisLocks.delete(job.id);
		}
	}

	private async runSynthesis(
		ctx: ExtensionContext,
		cwd: string,
		job: ReviewJob,
	): Promise<void> {
		await runSynthesisTask(ctx, cwd, job, {
			retryOnModelError: this.retryOnModelError,
			onComplete: (completedJob) => this.onComplete?.(completedJob),
		});
	}

	async runReview(
		ctx: ExtensionContext,
		pi: ExtensionAPI,
		cwd: string,
		files: ChangedFile[],
		diffs: Map<string, string>,
		contents:
			| Map<string, { content: string; lineCount: number; truncated: boolean }>
			| undefined,
		projectIndex: import("./git-diff.js").ProjectIndexEntry[] | undefined,
		options: {
			model?: string;
			lenses?: ReviewLens[];
			target?: ReviewResultTarget;
			onProgress?: (job: ReviewJob) => void;
			progressIntervalMs?: number;
			severityOverrides?: readonly import("./config.js").SeverityOverrideRule[];
			ignorePatterns?: readonly string[];
			suppressions?: ReadonlyArray<{
				riskCode: string;
				pattern: string;
				id: string;
			}>;
			commands?: { test?: string; lint?: string };
			pathInstructions?: readonly import("./config.js").ReviewPathInstruction[];
			/**
			 * Active risk-targeting constraints rendered into the lens
			 * system prompt. Built by `buildActiveConstraints` from the
			 * effective config. Required to reach the lens prompts from
			 * this entry point (the autoreview tool path); previously
			 * dropped, so risk-targeting config was silently ignored here.
			 */
			activeConstraints?: string;
			/**
			 * Run the selective validator stage. Defaults to true; set false
			 * only for an explicitly latency-sensitive review.
			 */
			validate?: boolean;
			/** Configured minimum health score for a passing quality gate. */
			qualityGateThreshold?: number;
			findingBudget?: import("./finding-budget.js").FindingBudget;
			/** Scope-preparation failures collected before lens execution. */
			preparationErrors?: readonly string[];
		},
		signal?: AbortSignal,
	): Promise<ReviewResult> {
		const jobId = await this.startReview(
			ctx,
			pi,
			cwd,
			files,
			diffs,
			contents,
			projectIndex,
			{
				model: options.model,
				lenses: options.lenses,
				commands: options.commands,
				pathInstructions: options.pathInstructions,
				activeConstraints: options.activeConstraints,
				mode: options.target?.mode,
				scopeLabel: options.target?.label,
			},
		);
		const started = this.jobs.get(jobId);
		if (started) safeProgress(options.onProgress, started);
		const job = await this.waitForReview(
			jobId,
			signal,
			options.onProgress,
			options.progressIntervalMs,
		);
		// Load the project's recorded-rejection store before building the
		// result so previously-rejected findings can be downranked.
		// loadRejections is best-effort: a missing or garbled file
		// degrades to [], so a broken store never breaks a review.
		const rejections = await loadRejections(cwd);
		const resultOptions = {
			target: options.target,
			severityOverrides: options.severityOverrides,
			ignorePatterns: options.ignorePatterns,
			suppressions: options.suppressions,
			rejections,
			prevScore: await computePrevScore(options.target?.label),
			qualityGateThreshold: options.qualityGateThreshold,
			findingBudget: options.findingBudget,
			preparationErrors: options.preparationErrors,
		};
		let result = buildReviewResult(job, resultOptions);

		// Validation is on by default, but only high-impact or weakly-grounded
		// singleton findings warrant another model call. Refuted findings are
		// removed from the active result before scoring and finalization.
		const candidates =
			options.validate === false
				? []
				: selectFindingsForValidation(result.findings);
		if (candidates.length > 0) {
			const diffBlock = formatDiffsForValidator(diffs);
			const validation = await runValidator(ctx, candidates, diffBlock, {
				signal,
			});
			const annotatedByKey = new Map(
				validation.findings.map((finding) => [
					getFindingIdentity(finding),
					finding,
				]),
			);
			const discarded = validation.findings.filter(
				(finding) => finding._validatorVerdict === "false-positive",
			);
			// Rebuild from the raw synthesis findings, not the already-rendered
			// result. This preserves ignore/suppression/rejection accounting and
			// avoids running policy transforms twice.
			const survivors = (job.synthesisResult?.findings ?? []).flatMap(
				(finding) => {
					const annotated = annotatedByKey.get(getFindingIdentity(finding));
					if (annotated?._validatorVerdict === "false-positive") return [];
					if (!annotated) return [finding];
					return [
						{
							...finding,
							_validatorVerdict: annotated._validatorVerdict,
							...(annotated._validatorJustification
								? {
										_validatorJustification: annotated._validatorJustification,
									}
								: {}),
						},
					];
				},
			);
			result = buildReviewResult(job, {
				...resultOptions,
				findings: survivors,
				discardedFindings: discarded,
				validatorError: validation.errorMessage,
				validatorCounts: {
					real: validation.confirmedReal,
					falsePositive: validation.droppedFalsePositives,
					unverified: validation.unverified,
				},
			});
		}
		// Fire-and-forget persist history
		appendHistory({
			date: new Date().toISOString(),
			mode: options.target?.label ?? "unknown",
			score: result.healthScore,
			breakdown: result.scoreBreakdown,
			totalFindings: result.counts.total,
			verdict: result.verdict,
		}).catch(() => {});
		return result;
	}

	waitForReview(
		id: string,
		signal?: AbortSignal,
		onProgress?: (job: ReviewJob) => void,
		progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
	): Promise<ReviewJob> {
		const existing = this.jobs.get(id);
		if (!existing)
			return Promise.reject(new Error(`Unknown review job: ${id}`));
		if (
			existing.overallStatus === "done" ||
			existing.overallStatus === "error"
		) {
			return Promise.resolve(existing);
		}

		return new Promise((resolve, reject) => {
			let lastProgressAt = 0;
			const interval = setInterval(() => {
				const job = this.jobs.get(id);
				if (!job) {
					cleanup();
					reject(new Error(`Review job disappeared: ${id}`));
					return;
				}
				const now = Date.now();
				if (
					onProgress &&
					progressIntervalMs >= 0 &&
					now - lastProgressAt >= progressIntervalMs
				) {
					lastProgressAt = now;
					safeProgress(onProgress, job);
				}
				if (job.overallStatus === "done" || job.overallStatus === "error") {
					cleanup();
					safeProgress(onProgress, job);
					resolve(job);
				}
			}, 100);
			interval.unref?.();

			const onAbort = () => {
				cleanup();
				reject(new Error(`Review job wait aborted: ${id}`));
			};
			const cleanup = () => {
				clearInterval(interval);
				signal?.removeEventListener("abort", onAbort);
			};

			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	listJobs(): ReviewJob[] {
		return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	recordFinalResult(result: ReviewResult): void {
		const job = this.jobs.get(result.jobId);
		if (!job) return;
		job.finalResult = result;
		this.onUpdate?.(job);
	}

	/** Clean up completed jobs older than 10 minutes. */
	private cleanup() {
		const cutoff = Date.now() - 10 * 60_000;
		for (const [id, job] of this.jobs) {
			if (job.overallStatus === "done" || job.overallStatus === "error") {
				if ((job.completedAt ?? 0) < cutoff) {
					this.disposeJobSessions(job);
					this.jobs.delete(id);
				}
			}
		}
	}

	private disposeJobSessions(job: ReviewJob) {
		for (const lens of job.lenses) {
			const state = job.states.get(lens);
			if (state?.session) {
				try {
					state.session.dispose();
				} catch {
					/* ignore */
				}
				state.session = undefined;
			}
		}
		if (job.synthesisSession) {
			try {
				job.synthesisSession.dispose();
			} catch {
				/* ignore */
			}
			job.synthesisSession = undefined;
		}
	}

	startCleanup() {
		setInterval(() => this.cleanup(), 60_000).unref();
	}

	abort(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job) return false;

		// Signal abort to all running subagents for this job
		const controller = this.abortControllers.get(id);
		if (controller) {
			controller.abort();
			this.abortControllers.delete(id);
		}

		// Remove pending tasks for this job
		this.taskQueue = this.taskQueue.filter((t) => t.jobId !== id);
		job.overallStatus = "error";
		job.completedAt = Date.now();
		this.disposeJobSessions(job);

		// Notify UI
		try {
			this.onComplete?.(job);
		} catch {
			/* don't let callback errors crash */
		}

		return true;
	}
}
