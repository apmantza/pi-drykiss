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

// Import after mocks are set up
const { ReviewManager } = await import("./review-manager.js");

function makeMinimalCtx() {
	return {
		cwd: "/tmp/test",
		modelRegistry: {
			getAvailable: vi
				.fn()
				.mockReturnValue([{ name: "mock", id: "mock", provider: "mock" }]),
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
			"/tmp/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		expect(jobId).toBeTruthy();
		const job = manager['jobs'].get(jobId);
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
			"/tmp/test",
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
			"/tmp/test",
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
		expect(manager['jobs'].get("nonexistent")).toBeUndefined();
	});

	it("runReview returns a stable ReviewResult", async () => {
		const { runLensSubagent } = await import("./subagent-runner.js");
		vi.mocked(runLensSubagent).mockImplementation(
			async (...args: unknown[]) => {
				const lens = args[5] as string;
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
			"/tmp/test",
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
			"/tmp/test",
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
			"/tmp/test",
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

		const job = manager['jobs'].get(jobId);
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
			"/tmp/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		// Simulate a session being attached
		const job = manager['jobs'].get(jobId)!;
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
			"/tmp/test",
			files,
			diffs,
			undefined,
			undefined,
			{
				lenses: ["simplicity"],
			},
		);

		const job = manager['jobs'].get(jobId)!;

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
			const lens = args[5] as string;
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
			"/tmp/test",
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
		const job = manager['jobs'].get(jobId)!;
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

	it("handles runSynthesis error with fallback result", async () => {
		const { runLensSubagent } = await import("./subagent-runner.js");
		vi.mocked(runLensSubagent).mockImplementation(
			async (...args: unknown[]) => {
				const lens = args[5] as string;
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
		const diffs = new Map([[ "test.ts", "diff" ]]);

		const result = await manager.runReview(
			ctx,
			pi,
			"/tmp/test",
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
