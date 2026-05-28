import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ReviewLens, ChangedFile, SynthesisResult } from "./types.js";
import { buildReviewPrompts, buildSynthesisPrompt } from "./prompt-builder.js";
import { saveReview } from "./persist.js";
import { findModelByHint } from "./llm.js";

const CONCURRENCY = 3;

export type LensStatus = "queued" | "running" | "done" | "error";

export interface LensState {
	status: LensStatus;
	modelName: string;
	durationMs: number;
	errorMessage?: string;
	findingsCount: number;
	rawOutput: string;
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
	}[] = [];

	/** Number of lens subagents currently running. */
	private runningCount = 0;

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
		const lenses: ReviewLens[] = options.lenses ?? [
			"simplicity",
			"deduplication",
			"clarity",
			"resilience",
			"architecture",
			"tests",
		];

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
			this.runLens(ctx, pi, cwd, task).catch(() => {
				/* errors handled inside runLens */
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
		},
	) {
		const { runLensSubagent } = await import("./subagent-runner.js");
		const job = this.jobs.get(task.jobId);
		if (!job) return;

		const state = job.states.get(task.lens)!;
		state.status = "running";
		this.onUpdate?.(job);

		const result = await runLensSubagent(
			ctx,
			cwd,
			task.model,
			task.systemPrompt,
			task.userPrompt,
			task.lens,
		);

		state.durationMs = result.durationMs;
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
			} catch {
				state.findingsCount = 0;
			}
		}

		this.runningCount--;
		this.onUpdate?.(job);

		// Check if all lenses for this job are done
		const allDone = job.lenses.every((l) => {
			const s = job.states.get(l)!;
			return s.status === "done" || s.status === "error";
		});

		if (allDone && job.synthesisStatus === "idle") {
			job.synthesisStatus = "running";
			this.onUpdate?.(job);
			try {
				await this.runSynthesis(ctx, cwd, job);
			} catch {
				/* handled inside */
			}
		}

		// Keep draining
		this.drain(ctx, pi, cwd);
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
			job.synthesisResult = {
				findings: [],
				summary: `Synthesis failed: ${err.message}`,
				verdict: "Request changes",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
			};
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
				? (parsed.findings as any[]).map((f: any) => ({
						file: String(f.file ?? "unknown"),
						line: typeof f.line === "number" ? f.line : undefined,
						severity: String(f.severity ?? "medium") as
							| "critical"
							| "high"
							| "medium"
							| "low"
							| "nit",
						category: String(f.category ?? ""),
						summary: String(f.summary ?? ""),
						detail: String(f.detail ?? f.summary ?? ""),
						suggestion: String(f.suggestion ?? ""),
						confidence: String(f.confidence ?? "likely") as
							| "confirmed"
							| "likely"
							| "suspect",
					}))
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
		} catch {
			return {
				findings: [],
				summary:
					"Synthesis returned non-JSON output. Raw response available in logs.",
				verdict: "Request changes",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
			};
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
					this.jobs.delete(id);
				}
			}
		}
	}

	startCleanup() {
		setInterval(() => this.cleanup(), 60_000).unref();
	}

	abort(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job) return false;
		// Remove pending tasks for this job
		this.taskQueue = this.taskQueue.filter((t) => t.jobId !== id);
		job.overallStatus = "error";
		job.completedAt = Date.now();
		return true;
	}
}
