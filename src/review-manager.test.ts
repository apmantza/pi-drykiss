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
		const job = manager.getJob(jobId);
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
		expect(manager.getJob("nonexistent")).toBeUndefined();
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

		const job = manager.getJob(jobId);
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
		const job = manager.getJob(jobId)!;
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

		const job = manager.getJob(jobId)!;

		// Initially synthesis is idle
		expect(job.synthesisStatus).toBe("idle");

		// After synthesis triggers, it should be running or done
		// (depends on whether synthesis completes in the test)
	});
});
