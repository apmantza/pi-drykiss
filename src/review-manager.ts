import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ReviewLens, ChangedFile, SynthesisResult } from "./types.js";
import {
	LENS_NAMES,
	createFallbackSynthesis,
	parseSynthesis,
} from "./types.js";
import { parseFindingsJson } from "./parse-findings.js";
import {
	buildReviewPrompts,
	buildBucketedSynthesisPrompt,
	buildSynthesisPrompt,
} from "./prompt-builder.js";
import {
	saveReview,
	saveSessionLog,
	appendHistory,
	loadHistory,
} from "./persist.js";
import type { SubagentResult } from "./subagent-runner.js";
import { findModelByHint } from "./llm.js";
import { isModelError, selectModelOnError } from "./model-selector.js";
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
	type ReviewResult,
	type ReviewResultTarget,
} from "./review-result.js";
import { loadRejections } from "./rejections.js";
import { runValidator } from "./validator.js";

const CONCURRENCY = 3;
const DEFAULT_PROGRESS_INTERVAL_MS = 1000;

export type LensStatus = "queued" | "running" | "done" | "error";

export interface LensState {
	status: LensStatus;
	modelName: string;
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
	overallStatus: "queued" | "running" | "done" | "error";
	startedAt: number;
	completedAt?: number;
}

export type OnReviewUpdate = (job: ReviewJob) => void;
export type OnReviewComplete = (job: ReviewJob) => void;

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

function applySuccessfulLensOutput(
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

export class ReviewManager {
	private jobs = new Map<string, ReviewJob>();
	private onUpdate?: OnReviewUpdate;
	private onComplete?: OnReviewComplete;

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
	private abortControllers = new Map<string, AbortController>();

	/** Locks to prevent concurrent synthesis runs for the same job. */
	private synthesisLocks = new Set<string>();
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
	): Promise<SubagentResult | null> {
		const selected = await selectModelOnError(
			ctx,
			{ provider: failedModel.provider, id: failedModel.id },
			"Model Error",
			`Model "${failedModel.name}" failed.\n\nChoose a different model for ${taskLabel}:`,
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
		});
		const promptMap = new Map(allPrompts.map((p) => [p.lens, p]));

		// Initialize job
		const states = new Map<ReviewLens, LensState>();
		for (const lens of lenses) {
			states.set(lens, {
				status: "queued",
				modelName: modelMap.get(lens)?.name ?? "unknown",
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
			this.drain(ctx, pi, cwd).catch((err) => {
				console.warn(`${LOG_PREFIX} Review queue drain failed:`, err);
			});
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
					this.drain(ctx, pi, cwd).catch((err) => {
						console.warn(`${LOG_PREFIX} Review queue drain failed:`, err);
					});
				});
		}
	}

	private async runLens(
		ctx: ExtensionContext,
		pi: ExtensionAPI,
		cwd: string,
		task: {
			jobId: string;
			lens: ReviewLens;
			model: Model<Api>;
			systemPrompt: string;
			userPrompt: string;
			signal: AbortSignal;
			onStreamUpdate: () => void;
		},
	) {
		const job = this.jobs.get(task.jobId);
		if (!job) return;

		const state = job.states.get(task.lens)!;
		state.status = "running";
		state.startedAt = Date.now();
		try {
			this.onUpdate?.(job);
		} catch {
			/* don't let callback errors crash the loop */
		}

		const { runLensSubagent } = await import("./subagent-runner.js");
		const result = await runLensSubagent(
			ctx,
			cwd,
			task.model,
			task.systemPrompt,
			task.userPrompt,
			task.lens,
			task.signal,
			() => {
				// Update streaming text for live progress display
				state.streamingText = "streaming...";
				task.onStreamUpdate();
			},
		);

		state.durationMs = result.durationMs;
		state.session = result.session;
		try {
			state.logPath = await saveSessionLog(job.id, task.lens, result.session);
		} catch (err) {
			console.warn(
				`${LOG_PREFIX} Failed to save session log for ${task.lens}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
		if (result.errorMessage) {
			// Check if this is a model error (quota/auth) that should trigger model selection
			const isModelErr = isModelError(result.errorMessage);
			if (isModelErr) {
				// Auto-route to a free model if the user has configured it;
				// otherwise show the standard picker popup. Exclude the model
				// that just failed so autorouting can't loop on it.
				const retryResult = await this.retryOnModelError(
					ctx,
					task.model,
					state.session,
					task.lens,
					async (m) =>
						runLensSubagent(
							ctx,
							cwd,
							m,
							task.systemPrompt,
							task.userPrompt,
							task.lens,
							task.signal,
							() => {
								state.streamingText = "streaming...";
								task.onStreamUpdate();
							},
						),
				);
				if (retryResult) {
					state.session = retryResult.session;
					try {
						state.logPath = await saveSessionLog(
							job.id,
							task.lens,
							retryResult.session,
						);
					} catch (err) {
						console.warn(
							`${LOG_PREFIX} Failed to save session log for ${task.lens}:`,
							err instanceof Error ? err.message : String(err),
						);
					}
					if (retryResult.errorMessage) {
						state.status = "error";
						state.errorMessage = retryResult.errorMessage;
						state.rawOutput = `ERROR: ${retryResult.errorMessage}`;
					} else {
						applySuccessfulLensOutput(state, retryResult.text, task.lens);
					}
				} else {
					state.status = "error";
					state.errorMessage = result.errorMessage;
					state.rawOutput = `ERROR: ${result.errorMessage}`;
					state.session = undefined;
				}
			} else {
				// Not a model error or no UI - just record the error
				state.status = "error";
				state.errorMessage = result.errorMessage;
				state.rawOutput = `ERROR: ${result.errorMessage}`;
			}
		} else {
			applySuccessfulLensOutput(state, result.text, task.lens);
		}

		try {
			this.onUpdate?.(job);
		} catch {
			/* don't let callback errors crash the loop */
		}

		// Check if all lenses for this job are done
		const allDone = job.lenses.every((l) => {
			const s = job.states.get(l)!;
			return s.status === "done" || s.status === "error";
		});

		// Atomic check-and-set: use a lock set to prevent concurrent synthesis runs
		if (allDone && !this.synthesisLocks.has(job.id)) {
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

		// Keep draining - catch errors to prevent unhandled rejections
		this.drain(ctx, pi, cwd).catch((err) => {
			console.warn(`${LOG_PREFIX} Review queue drain failed:`, err);
		});
	}

	private async runSynthesis(
		ctx: ExtensionContext,
		cwd: string,
		job: ReviewJob,
	) {
		const { runLensSubagent } = await import("./subagent-runner.js");
		const { resolveModel } = await import("./subagent-runner.js");

		const lensReviews = job.lenses.map((l) => ({
			lens: l,
			rawOutput: job.states.get(l)!.rawOutput,
		}));

		// Cluster lens findings by file + line proximity + Jaccard before
		// the synthesis prompt is built. The LLM still does the final
		// semantic merge — cluster boundaries are advisory — but it
		// reasons over a pre-deduplicated view that's dramatically
		// smaller and more reliable than the raw N-lens output.
		// Fall back to the raw prompt builder if the bucketed one fails
		// (shouldn't happen, but the synthesis must never break on a
		// bucketing glitch).
		let systemPrompt: string;
		let userPrompt: string;
		try {
			({ systemPrompt, userPrompt } =
				await buildBucketedSynthesisPrompt(lensReviews));
		} catch (err) {
			console.warn(
				`${LOG_PREFIX} Bucketed synthesis prompt failed, falling back to raw:`,
				err,
			);
			({ systemPrompt, userPrompt } = await buildSynthesisPrompt(
				cwd,
				lensReviews,
			));
		}

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

			// Store the synthesis session so it can be disposed on job cleanup
			if (result.session) {
				// Dispose previous session if this is a retry
				if (job.synthesisSession && job.synthesisSession !== result.session) {
					try {
						job.synthesisSession.dispose();
					} catch {
						/* ignore */
					}
				}
				job.synthesisSession = result.session;
			}

			// Check for model error and retry with user-selected model
			if (result.errorMessage && isModelError(result.errorMessage)) {
				// Auto-route to a free model if the user has configured it;
				// otherwise show the standard picker popup. Exclude the model
				// that just failed so autorouting can't loop on it.
				const retryResult = await this.retryOnModelError(
					ctx,
					model,
					job.synthesisSession,
					"synthesis",
					async (m) =>
						runLensSubagent(ctx, cwd, m, systemPrompt, userPrompt, "synthesis"),
				);
				if (retryResult) {
					if (retryResult.session) {
						job.synthesisSession = retryResult.session;
					}
					if (retryResult.errorMessage) {
						job.synthesisResult = createFallbackSynthesis(
							`Synthesis failed: ${retryResult.errorMessage}`,
						);
					} else {
						const rawText = retryResult.text || "{}";
						job.synthesisResult = parseSynthesis(rawText);
					}
				} else {
					job.synthesisResult = createFallbackSynthesis(
						`Synthesis failed: ${result.errorMessage}`,
					);
				}
			} else if (result.errorMessage) {
				job.synthesisResult = createFallbackSynthesis(
					`Synthesis failed: ${result.errorMessage}`,
				);
			} else {
				const rawText = result.text || "{}";
				job.synthesisResult = parseSynthesis(rawText);
			}
			job.synthesisStatus = result.errorMessage ? "error" : "done";
		} catch (err: any) {
			job.synthesisStatus = "error";
			job.synthesisResult = createFallbackSynthesis(
				`Synthesis failed: ${err.message}`,
			);
		}

		job.overallStatus =
			job.lenses.some((l) => job.states.get(l)!.status === "error") ||
			job.synthesisStatus === "error"
				? "error"
				: "done";
		job.completedAt = Date.now();

		// Release synthesis lock
		this.synthesisLocks.delete(job.id);
		if (job.synthesisResult) {
			try {
				job.reviewPath = await saveReview(job.files, job.synthesisResult);
			} catch {
				/* Non-fatal: review result is still valid without persistence */
			}
		}

		this.onComplete?.(job);
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
			suppressions?: ReadonlyArray<{
				riskCode: string;
				pattern: string;
				id: string;
			}>;
			commands?: { test?: string; lint?: string };
			/**
			 * Opt-in: run the validator stage over the synthesized
			 * findings. The validator is a separate LLM call whose
			 * system prompt is in `_shared/validator.md`; it tries to
			 * falsify each finding and tags it "real" or
			 * "false-positive". Default false to preserve the existing
			 * cost/latency budget.
			 */
			validate?: boolean;
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
		let result = buildReviewResult(job, {
			target: options.target,
			severityOverrides: options.severityOverrides,
			suppressions: options.suppressions,
			rejections,
			prevScore: await computePrevScore(options.target?.label),
		});
		// Optional validator stage — opt-in via `options.validate`.
		// Runs an adversarial LLM call that tries to falsify each
		// synthesized finding. Fail-open: a flaky validator surfaces
		// findings unchanged, never silently drops them. The diff
		// block is included so the validator can see the actual code.
		if (options.validate && result.findings.length > 0) {
			const diffBlock = formatDiffsForValidator(diffs);
			const validation = await runValidator(ctx, result.findings, diffBlock, {
				signal,
			});
			// Build a new result with the validator-annotated findings
			// + extra counts. The base `findings` and `counts` are
			// read-only on ReviewResult, so we spread.
			result = {
				...result,
				findings: validation.findings,
				counts: {
					...result.counts,
					validatorReal: validation.confirmedReal,
					validatorFalsePositive: validation.droppedFalsePositives,
					validatorUnverified: validation.unverified,
				},
			};
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
