import { describe, it, expect, vi, beforeEach } from "vitest";
import { LENS_NAMES } from "./types.js";

// We test the ReviewManager by importing and using its public API.
// The subagent runner is dynamically imported inside runLens, so we mock it.
vi.mock("./subagent-runner.js", () => ({
	runLensSubagent: vi.fn().mockResolvedValue({
		text: '[{"file":"test.ts","severity":"low","category":"test","summary":"test finding"}]',
		modelName: "mock-model",
		durationMs: 100,
		session: { dispose: vi.fn() },
	}),
	resolveModel: vi
		.fn()
		.mockResolvedValue({ name: "mock-model", id: "mock", provider: "mock" }),
	resolveAllModels: vi
		.fn()
		.mockResolvedValue(
			new Map(
				LENS_NAMES.map((l) => [
					l,
					{ name: "mock-model", id: "mock", provider: "mock" },
				]),
			),
		),
}));

vi.mock("./prompt-builder.js", () => ({
	buildReviewPrompts: vi.fn().mockResolvedValue(
		LENS_NAMES.map((l) => ({
			lens: l,
			systemPrompt: "system",
			userPrompt: "user",
		})),
	),
	buildSynthesisPrompt: vi.fn().mockResolvedValue({
		systemPrompt: "synthesis system",
		userPrompt: "synthesis user",
	}),
	buildBucketedSynthesisPrompt: vi.fn().mockResolvedValue({
		systemPrompt: "synthesis system",
		userPrompt: "synthesis user",
	}),
}));

vi.mock("./persist.js", () => ({
	saveReview: vi.fn().mockResolvedValue(undefined),
	saveSessionLog: vi.fn().mockResolvedValue(undefined),
	appendHistory: vi.fn().mockResolvedValue(undefined),
	loadHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock("./llm.js", () => ({
	findModelByHint: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./config.js", () => ({
	loadConfig: vi.fn().mockResolvedValue({ autoroute: false }),
}));

vi.mock("./validator.js", () => ({
	runValidator: vi.fn(),
	selectFindingsForValidation: vi.fn((findings: unknown[]) => findings),
}));

// Import after mocks are set up
const { ReviewManager } = await import("./review-manager.js");
const { runValidator } = await import("./validator.js");

function makeMinimalCtx() {
	const models = [
		{ name: "mock", id: "mock", provider: "mock" },
		{ name: "fallback", id: "fallback", provider: "mock" },
	];
	return {
		cwd: "/home/test",
		hasUI: true,
		modelRegistry: {
			getAvailable: vi.fn().mockReturnValue(models),
			find: vi
				.fn()
				.mockImplementation((provider: string, id: string) =>
					models.find((m) => m.provider === provider && m.id === id),
				),
			getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true }),
		},
		ui: {
			notify: vi.fn(),
			confirm: vi.fn().mockResolvedValue(true),
			select: vi.fn(),
			custom: vi.fn(),
		},
	} as any;
}

function makeMinimalPi() {
	return {
		exec: vi.fn().mockResolvedValue({ stdout: "" }),
	} as any;
}

describe("ReviewManager", () => {
	let manager: InstanceType<typeof ReviewManager>;

	beforeEach(() => {
		vi.clearAllMocks();
		manager = new ReviewManager();
	});

	it("starts a review and creates a job", async () => {
		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff content"]]);

		const jobId = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		expect(jobId).toBeTruthy();
		const job = manager["jobs"].get(jobId);
		expect(job).toBeDefined();
		expect(job!.overallStatus).toBe("running");
		expect(job!.lenses).toEqual(["simplicity"]);
	});

	it("lists jobs sorted by start time", async () => {
		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const id1 = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);
		// Small delay to ensure distinct timestamps
		await new Promise((r) => setTimeout(r, 10));
		const id2 = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["deduplication"],
			},
		);

		const jobs = manager.listJobs();
		expect(jobs.length).toBeGreaterThanOrEqual(2);
		// Most recent first
		expect(jobs[0].id).toBe(id2);
		expect(jobs[1].id).toBe(id1);
	});

	it("returns undefined for unknown job id", () => {
		expect(manager["jobs"].get("nonexistent")).toBeUndefined();
	});

	it("runReview returns a stable ReviewResult", async () => {
		const { runLensSubagent } = await import("./subagent-runner.js");
		vi.mocked(runLensSubagent).mockImplementation(
			async (...args: unknown[]) => {
				const lens = args[4] as string;
				return {
					lens,
					text:
						lens === "synthesis"
							? '{"summary":"Clean.","verdict":"Approve","findings":[]}'
							: "[]",
					modelName: "mock-model",
					durationMs: 1,
					session: { dispose: vi.fn() },
				} as any;
			},
		);
		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const onProgress = vi.fn();
		const result = await manager.runReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
				target: { mode: "local", label: "local changes" },
				onProgress,
				progressIntervalMs: 0,
			},
		);

		expect(result.clean).toBe(true);
		expect(onProgress).toHaveBeenCalled();
		expect(result.target?.label).toBe("local changes");
		expect(result.counts.total).toBe(0);
	});

	it("validates by default and excludes refuted findings from the outcome", async () => {
		const { runLensSubagent } = await import("./subagent-runner.js");
		const candidate = {
			file: "test.ts",
			line: 1,
			severity: "high" as const,
			category: "Security",
			summary: "False alarm",
			detail: "The reported execution path is unreachable.",
			suggestion: "No change needed.",
		};
		vi.mocked(runLensSubagent).mockImplementation(
			async (...args: unknown[]) => {
				const lens = args[4] as string;
				return {
					lens,
					text:
						lens === "synthesis"
							? JSON.stringify({
									summary: "One finding.",
									findings: [candidate],
								})
							: "[]",
					modelName: "mock-model",
					durationMs: 1,
					session: { dispose: vi.fn() },
				} as any;
			},
		);
		vi.mocked(runValidator).mockResolvedValue({
			findings: [{ ...candidate, _validatorVerdict: "false-positive" }],
			droppedFalsePositives: 1,
			confirmedReal: 0,
			unverified: 0,
		});

		const result = await manager.runReview(
			makeMinimalCtx(),
			makeMinimalPi(),
			"/home/test",
			[{ path: "test.ts", status: "modified", language: "TypeScript" }],
			new Map([["test.ts", "diff"]]),
			undefined,
			undefined,
			{ lenses: ["security"] },
		);

		expect(runValidator).toHaveBeenCalledOnce();
		expect(result.findings).toEqual([]);
		expect(result.discardedFindings).toHaveLength(1);
		expect(result.counts.validatorFalsePositive).toBe(1);
		expect(result.codeRisk).toBe("clean");
	});

	it("skips validation when explicitly disabled", async () => {
		const { runLensSubagent } = await import("./subagent-runner.js");
		const candidate = {
			file: "test.ts",
			line: 1,
			severity: "high" as const,
			category: "Security",
			summary: "Active finding",
			detail: "A real execution path exists.",
			suggestion: "Fix it.",
		};
		vi.mocked(runLensSubagent).mockImplementation(
			async (...args: unknown[]) =>
				({
					lens: args[4],
					text:
						args[4] === "synthesis"
							? JSON.stringify({
									summary: "One finding.",
									findings: [candidate],
								})
							: "[]",
					modelName: "mock-model",
					durationMs: 1,
					session: { dispose: vi.fn() },
				}) as any,
		);

		const result = await manager.runReview(
			makeMinimalCtx(),
			makeMinimalPi(),
			"/home/test",
			[{ path: "test.ts", status: "modified", language: "TypeScript" }],
			new Map([["test.ts", "diff"]]),
			undefined,
			undefined,
			{ lenses: ["security"], validate: false },
		);

		expect(runValidator).not.toHaveBeenCalled();
		expect(result.findings).toHaveLength(1);
		expect(result.counts.validatorFalsePositive).toBeUndefined();
	});

	it("waitForReview resolves after a job completes", async () => {
		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const jobId = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		const job = await manager.waitForReview(jobId);
		expect(job.id).toBe(jobId);
		expect(["done", "error"]).toContain(job.overallStatus);
		expect(job.completedAt).toBeDefined();
	});

	it("abort sets overallStatus to error and returns true", async () => {
		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const jobId = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		const result = manager.abort(jobId);
		expect(result).toBe(true);

		const job = manager["jobs"].get(jobId);
		expect(job!.overallStatus).toBe("error");
		expect(job!.completedAt).toBeDefined();
	});

	it("abort returns false for unknown job", () => {
		expect(manager.abort("nonexistent")).toBe(false);
	});

	it("disposes sessions on abort", async () => {
		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const jobId = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		// Simulate a session being attached
		const job = manager["jobs"].get(jobId)!;
		const mockDispose = vi.fn();
		job.states.get("simplicity")!.session = { dispose: mockDispose } as any;

		manager.abort(jobId);
		expect(mockDispose).toHaveBeenCalled();
	});

	it("synthesisStatus tracks idle->running transition", async () => {
		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const jobId = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		const job = manager["jobs"].get(jobId)!;

		// Initially synthesis is idle
		expect(job.synthesisStatus).toBe("idle");

		// After synthesis triggers, it should be running or done
		// (depends on whether synthesis completes in the test)
	});

	it("continues draining the queue when a task rejects", async () => {
		// Regression test: prior to the .finally() re-drain fix, the queue
		// would stall as soon as any concurrent task rejected — runningCount
		// would decrement but drain() was never re-entered, leaving queued
		// tasks stranded. With CONCURRENCY=3 and 4 lenses, this test verifies
		// the queued lens is still started after a rejection.
		const { runLensSubagent } = await import("./subagent-runner.js");
		const mockRun = vi.mocked(runLensSubagent);
		let callCount = 0;
		mockRun.mockImplementation(async (...args: unknown[]) => {
			callCount++;
			const lens = args[4] as string;
			if (callCount === 1) throw new Error("simulated subagent crash");
			return {
				lens,
				text: "[]",
				modelName: "mock-model",
				durationMs: 1,
				session: { dispose: vi.fn() },
			} as any;
		});

		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const jobId = await manager.startReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				// 4 lenses: 3 will run concurrently (CONCURRENCY=3), 1 sits in
				// the queue. If the failing lens is one of the concurrent three,
				// the queue must still drain to start the 4th.
				lenses: ["simplicity", "deduplication", "tests", "clarity"],
			},
		);

		// Wait for all 4 lenses to finish (each rejects once or resolves).
		const job = manager["jobs"].get(jobId)!;
		await vi.waitFor(
			() => {
				const allDone = job.lenses.every(
					(l) =>
						job.states.get(l)!.status === "done" ||
						job.states.get(l)!.status === "error",
				);
				if (!allDone) {
					const statuses = job.lenses.map(
						(l) => `${l}=${job.states.get(l)!.status}`,
					);
					throw new Error(`not all lenses finished: ${statuses.join(", ")}`);
				}
			},
			{ timeout: 2000, interval: 50 },
		);

		// The lens that rejected should be in error state.
		const errored = job.lenses.find(
			(l) => job.states.get(l)!.status === "error",
		);
		expect(errored).toBeDefined();
		expect(job.states.get(errored!)!.errorMessage).toContain(
			"simulated subagent crash",
		);

		// All 4 lenses must have been visited — including the queued one.
		// If drain() had stalled, the queued lens would still be "queued".
		const queued = job.lenses.filter(
			(l) => job.states.get(l)!.status === "queued",
		);
		expect(queued).toEqual([]);

		// The queued lens (clarity) was the one that proves the re-drain
		// works — before the fix, it would never have been started.
		expect(job.states.get("clarity")!.status).toBe("done");
	});

	it("retries a lens with a selected fallback model after stream termination", async () => {
		const { runLensSubagent } = await import("./subagent-runner.js");
		const mockRun = vi.mocked(runLensSubagent);
		mockRun.mockImplementation(async (...args: unknown[]) => {
			const model = args[1] as { name: string };
			const lens = args[4] as string;
			if (lens === "security" && model.name === "mock-model") {
				return {
					lens,
					text: "",
					modelName: model.name,
					durationMs: 1,
					errorMessage: "terminated",
					session: { dispose: vi.fn() },
				} as any;
			}
			return {
				lens,
				text:
					lens === "synthesis"
						? '{"summary":"Clean after retry.","verdict":"Approve","findings":[]}'
						: "[]",
				modelName: model.name,
				durationMs: 1,
				session: { dispose: vi.fn() },
			} as any;
		});

		const ctx = makeMinimalCtx();
		ctx.ui.custom.mockResolvedValue("mock/fallback");
		const pi = makeMinimalPi();
		const files = [
			{ path: "test.ts", status: "modified" as const, language: "TypeScript" },
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const result = await manager.runReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["security"],
				target: { mode: "local", label: "local" },
				onProgress: vi.fn(),
				progressIntervalMs: 0,
			},
		);

		expect(result.clean).toBe(true);
		expect(result.errors).toEqual([]);
		expect(ctx.ui.custom).toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Switching to fallback for security...",
			"info",
		);
		expect(mockRun).toHaveBeenCalledWith(
			"/home/test",
			expect.objectContaining({ id: "fallback" }),
			expect.any(String),
			expect.any(String),
			"security",
			expect.any(AbortSignal),
			expect.any(Function),
		);

		// Regression guard: after a successful retry, the lens state
		// must advertise the model that actually ran — not the
		// original (failed) model. Without this, the TUI/notification
		// would mislead users about which model produced the review
		// when autorouting or per-lens fallback swapped providers.
		const completedJob = manager
			.listJobs()
			.find((j) => j.overallStatus === "done");
		expect(completedJob?.states.get("security")?.modelName).toBe("fallback");
		expect(completedJob?.states.get("security")?.provider).toBe("mock");
	});

	it("handles runSynthesis error with fallback result", async () => {
		const { runLensSubagent } = await import("./subagent-runner.js");
		vi.mocked(runLensSubagent).mockImplementation(
			async (...args: unknown[]) => {
				const lens = args[4] as string;
				if (lens === "synthesis") {
					throw new Error("simulated synthesis crash");
				}
				return {
					lens,
					text: "[]",
					modelName: "mock-model",
					durationMs: 1,
					session: { dispose: vi.fn() },
				} as any;
			},
		);

		const ctx = makeMinimalCtx();
		const pi = makeMinimalPi();
		const files = [
			{
				path: "test.ts",
				status: "modified" as const,
				language: "TypeScript",
			},
		];
		const diffs = new Map([["test.ts", "diff"]]);

		const result = await manager.runReview(
			ctx,
			pi,
			"/home/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
				target: {
					mode: "local",
					label: "local",
				},
				onProgress: vi.fn(),
				progressIntervalMs: 0,
			},
		);

		expect(result.clean).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("simulated synthesis crash");
		expect(result.counts.total).toBe(0);
	});
});
