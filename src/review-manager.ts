import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ReviewLens, ChangedFile, SynthesisResult } from "./types.js";
import { LENS_NAMES, mapRawToFinding } from "./types.js";
import { buildReviewPrompts, buildSynthesisPrompt } from "./prompt-builder.js";
import { saveReview } from "./persist.js";
import { findModelByHint } from "./llm.js";

const CONCURRENCY = 3;

/** Create a fallback SynthesisResult for error cases. */
function createFallbackSynthesis(summary: string): SynthesisResult {
	return {
		findings: [],
		summary,
		verdict: "Request changes",
		criticalCount: 0,
		highCount: 0,
		mediumCount: 0,
		lowCount: 0,
		nitCount: 0,
	};
}

export type LensStatus = "queued" | "running" | "done" | "error";

export interface LensState {
	status: LensStatus;
	modelName: string;
	durationMs: number;
	errorMessage?: string;
	findingsCount: number;
	rawOutput: string;
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
	overallStatus: "queued" | "running" | "done" | "error";
	startedAt: number;
	completedAt?: number;
}

export type OnReviewUpdate = (job: ReviewJob) => void;
export type OnReviewComplete = (job: ReviewJob) => void;

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
			modelMap = await resolveAllModels(ctx, cwd, lenses);
		}

		// Build prompts
		const allPrompts = await buildReviewPrompts(cwd, files, diffs, "all", {
			contents,
			projectIndex,
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

		// Queue all lens tasks
		for (const lens of lenses) {
			const prompt = promptMap.get(lens);
			const model = modelMap.get(lens);
			if (!prompt || !model) {
				const s = states.get(lens)!;
				s.status = "error";
				s.errorMessage = !prompt ? "No prompt generated" : "No model resolved";
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
		this.drain(ctx, pi, cwd);
		return id;
	}

	private async drain(ctx: ExtensionContext, pi: ExtensionAPI, cwd: string) {
		while (this.taskQueue.length > 0 && this.runningCount < CONCURRENCY) {
			const task = this.taskQueue.shift()!;
			this.runningCount++;
			this.runLens(ctx, pi, cwd, task).catch((err) => {
				/* Ensure runningCount is always decremented even on unexpected errors */
				const job = this.jobs.get(task.jobId);
				if (job) {
					const state = job.states.get(task.lens);
					if (state && state.status === "running") {
						state.status = "error";
						state.errorMessage =
							err instanceof Error ? err.message : String(err);
					}
				}
				this.runningCount--;
				try {
					this.onUpdate?.(job!);
				} catch {
					/* don't let callback errors crash the loop */
				}
				console.error(`[DRYKISS] runLens crashed for ${task.lens}:`, err);
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
		const { runLensSubagent } = await import("./subagent-runner.js");
		const job = this.jobs.get(task.jobId);
		if (!job) return;

		const state = job.states.get(task.lens)!;
		state.status = "running";
		try {
			this.onUpdate?.(job);
		} catch {
			/* don't let callback errors crash the loop */
		}

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
		if (result.errorMessage) {
			state.status = "error";
			state.errorMessage = result.errorMessage;
			state.rawOutput = `ERROR: ${result.errorMessage}`;
		} else {
			state.status = "done";
			state.rawOutput = result.text || "[]";
			try {
				const arr = JSON.parse(
					(state.rawOutput.match(/\[[\s\S]*\]/)?.[0] ?? state.rawOutput) ||
						"[]",
				);
				state.findingsCount = Array.isArray(arr) ? arr.length : 0;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(
					`[DRYKISS] Failed to parse findings JSON for ${task.lens}:`,
					msg,
				);
				// Note: Raw output not logged to avoid sensitive data exposure
				state.findingsCount = 0;
			}
		}

		this.runningCount--;
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

		// Atomic check-and-set: use compareExchange pattern to prevent race condition
		if (allDone && job.synthesisStatus === "idle") {
			job.synthesisStatus = "running";
			try {
				this.onUpdate?.(job);
			} catch {
				/* don't let callback errors crash the loop */
			}
			try {
				await this.runSynthesis(ctx, cwd, job);
			} catch {
				/* handled inside */
			}
		}

		// Keep draining - catch errors to prevent unhandled rejections
		this.drain(ctx, pi, cwd).catch((err) => {
			console.error(`[DRYKISS] drain failed:`, err);
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

		const { systemPrompt, userPrompt } = await buildSynthesisPrompt(
			cwd,
			lensReviews,
		);

		const model = await resolveModel(ctx, cwd, "synthesis");

		try {
			const result = await runLensSubagent(
				ctx,
				cwd,
				model,
				systemPrompt,
				userPrompt,
				"synthesis",
			);

			const raw = result.errorMessage
				? `ERROR: ${result.errorMessage}`
				: result.text || "{}";

			job.synthesisResult = this.parseSynthesis(raw);
			job.synthesisStatus = "done";
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

		// Persist
		if (job.synthesisResult) {
			await saveReview(cwd, job.files, job.synthesisResult);
		}

		this.onComplete?.(job);
	}

	private parseSynthesis(raw: string): SynthesisResult {
		try {
			const jsonMatch = raw.match(/\{[\s\S]*\}/);
			const jsonStr = jsonMatch ? jsonMatch[0] : raw;
			const parsed = JSON.parse(jsonStr);
			if (typeof parsed !== "object" || parsed === null) {
				throw new Error("Not an object");
			}
			const findings = Array.isArray(parsed.findings)
				? (parsed.findings as any[]).map((f) => mapRawToFinding(f))
				: [];
			return {
				findings,
				summary: String(parsed.summary ?? ""),
				verdict: String(
					parsed.verdict ?? "Request changes",
				) as SynthesisResult["verdict"],
				criticalCount: findings.filter((f) => f.severity === "critical").length,
				highCount: findings.filter((f) => f.severity === "high").length,
				mediumCount: findings.filter((f) => f.severity === "medium").length,
				lowCount: findings.filter((f) => f.severity === "low").length,
				nitCount: findings.filter((f) => f.severity === "nit").length,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[DRYKISS] Synthesis JSON parse failed:", msg);
			console.error(
				"[DRYKISS] Synthesis raw output (first 800 chars):",
				raw.slice(0, 800),
			);
			return createFallbackSynthesis(
				"Synthesis returned non-JSON output. Raw response available in logs.",
			);
		}
	}

	getJob(id: string): ReviewJob | undefined {
		return this.jobs.get(id);
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
