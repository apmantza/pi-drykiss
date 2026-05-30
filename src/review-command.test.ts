import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("./git-diff.js", () => ({
	getChangedFiles: vi.fn().mockResolvedValue([]),
	getFileDiff: vi.fn().mockResolvedValue("mock diff"),
	getFileContent: vi.fn().mockResolvedValue(null),
	getProjectIndex: vi.fn().mockResolvedValue([]),
}));

vi.mock("./prompt-builder.js", () => ({
	buildReviewPrompts: vi.fn().mockResolvedValue([
		{
			lens: "simplicity",
			systemPrompt: "system prompt",
			userPrompt: "user prompt",
		},
	]),
	ensureDefaultPrompts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./config.js", () => ({
	loadConfig: vi.fn().mockResolvedValue({
		interactive: false,
		confirmBeforeRun: false,
		contextMode: "full",
	}),
}));

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
}));

vi.mock("./llm.js", () => ({
	findModelByHint: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./persist.js", () => ({
	saveReview: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
const { parseArgs, handleDrykissCommand } = await import("./review-command.js");

// We need to test parseFindingsJson which is not exported.
// Let's test it indirectly through the module or create a wrapper.
// Actually, let's check if we can access it via the module internals.

// Since parseFindingsJson is not exported, we'll test it indirectly
// through the review command handlers or create a test helper.

describe("parseArgs", () => {
	it("parses --all flag", () => {
		const opts = parseArgs("--all");
		expect(opts.all).toBe(true);
	});

	it("parses --staged and --all together", () => {
		const opts = parseArgs("--staged --all");
		expect(opts.staged).toBe(true);
		expect(opts.all).toBe(true);
	});

	it("parses complex args", () => {
		const opts = parseArgs(
			"--staged --ref=develop --model=sonnet src/a.ts src/b.ts",
		);
		expect(opts.staged).toBe(true);
		expect(opts.ref).toBe("develop");
		expect(opts.model).toBe("sonnet");
		expect(opts.files).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("review command error handling", () => {
	let mockCtx: any;
	let mockPi: any;
	let mockManager: any;

	beforeEach(() => {
		vi.clearAllMocks();

		mockCtx = {
			cwd: "/tmp/test",
			ui: {
				notify: vi.fn(),
				confirm: vi.fn().mockResolvedValue(true),
				select: vi.fn(),
			},
			modelRegistry: {
				getAvailable: vi
					.fn()
					.mockReturnValue([{ name: "mock", id: "mock", provider: "mock" }]),
			},
			hasUI: true,
		};

		mockPi = {
			exec: vi.fn().mockResolvedValue({ stdout: "" }),
		};

		mockManager = {
			startReview: vi.fn().mockResolvedValue("job-123"),
			listJobs: vi.fn().mockReturnValue([]),
		};
	});

	it("returns early when no files found", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([]);

		await handleDrykissCommand("", mockCtx, mockPi, mockManager);

		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("No changed files"),
			"info",
		);
		expect(mockManager.startReview).not.toHaveBeenCalled();
	});

	it("cancels review when user declines confirmation", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);

		const { loadConfig } = await import("./config.js");
		vi.mocked(loadConfig).mockResolvedValue({
			interactive: false,
			confirmBeforeRun: true,
			contextMode: "full",
		});

		mockCtx.ui.confirm.mockResolvedValue(false);

		await handleDrykissCommand("", mockCtx, mockPi, mockManager);

		expect(mockCtx.ui.notify).toHaveBeenCalledWith("Review cancelled.", "info");
		expect(mockManager.startReview).not.toHaveBeenCalled();
	});

	it("handles startReview failure gracefully", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);

		mockManager.startReview.mockRejectedValue(new Error("Model not found"));

		await handleDrykissCommand("", mockCtx, mockPi, mockManager);

		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("DRYKISS review failed: Model not found"),
			"error",
		);
	});

	it("single lens command handles startReview failure", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);

		mockManager.startReview.mockRejectedValue(new Error("Lens failed"));

		// Test via handleDrykissCommand with a single lens option
		await handleDrykissCommand("--model=test", mockCtx, mockPi, mockManager);

		// Since confirmBeforeRun is false in mock config, it should proceed
		// and catch the error
		expect(mockCtx.ui.notify).toHaveBeenCalled();
	});
});
