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
	loadEffectiveConfig: vi.fn().mockResolvedValue({
		config: {},
		warnings: [],
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
	saveSessionLog: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
const {
	parseArgs,
	tokenizeArgs,
	handleDrykissCommand,
	handleEndReviewCommand,
	executeDrykissAutoreviewTool,
} = await import("./review-command.js");
const { clearReviewSession } = await import("./review-session.js");
const { parseFindingsJson } = await import("./parse-findings.js");

function makeReviewSessionManager() {
	return {
		getLeafId: vi.fn().mockReturnValue("origin-1"),
		getEntries: vi
			.fn()
			.mockReturnValue([
				{ id: "user-1", type: "message", message: { role: "user" } },
			]),
		getBranch: vi.fn().mockReturnValue([
			{
				type: "custom",
				customType: "drykiss-review-session",
				data: { active: true, originId: "origin-1" },
			},
		]),
	};
}

describe("parseFindingsJson", () => {
	it("parses a valid JSON findings array", () => {
		const result = parseFindingsJson(
			'[{"file":"src/a.ts","line":1,"severity":"low","category":"Test","summary":"ok","detail":"d","suggestion":"s"}]',
			"tests",
		);

		expect(result.parseError).toBeUndefined();
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].file).toBe("src/a.ts");
	});

	it("parses an array wrapped in markdown fences", () => {
		const result = parseFindingsJson(
			'```json\n[{"file":"src/a.ts","severity":"low","category":"Test","summary":"ok","detail":"d","suggestion":"s",}]\n```',
			"tests",
		);

		expect(result.parseError).toBeUndefined();
		expect(result.findings).toHaveLength(1);
	});

	it("does not truncate arrays when string values contain brackets", () => {
		const result = parseFindingsJson(
			'[{"file":"src/test[1].ts","severity":"medium","category":"Parser","summary":"bracket path","detail":"array literal contains ] inside a string","suggestion":"keep parsing"}]',
			"clarity",
		);

		expect(result.parseError).toBeUndefined();
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].file).toBe("src/test[1].ts");
	});

	it("accepts object-shaped model output with a findings array", () => {
		const result = parseFindingsJson(
			'{"findings":[{"file":"src/a.ts","severity":"low","category":"Test","summary":"ok","detail":"d","suggestion":"s"}]}',
			"simplicity",
		);

		expect(result.parseError).toBeUndefined();
		expect(result.findings).toHaveLength(1);
	});

	it("returns a parse error for non-array JSON", () => {
		const result = parseFindingsJson('{"summary":"not findings"}', "tests");

		expect(result.findings).toEqual([]);
		expect(result.parseError).toContain("Expected array");
	});

	it("returns a parse error for invalid JSON", () => {
		const result = parseFindingsJson("not json", "tests");

		expect(result.findings).toEqual([]);
		expect(result.parseError).toContain("Failed to parse JSON");
	});
});

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

	it("handles quoted file paths with spaces", () => {
		const opts = parseArgs('"src/my file.ts" "src/another file.ts"');
		expect(opts.files).toEqual(["src/my file.ts", "src/another file.ts"]);
	});

	it("preserves values inside quotes", () => {
		const opts = parseArgs('--ref="feature branch"');
		expect(opts.ref).toBe("feature branch");
		expect(opts.explicitRef).toBe(true);
	});

	it("parses isolated branch flag without treating it as a file", () => {
		const opts = parseArgs("--branch --model=sonnet");
		expect(opts.branch).toBe(true);
		expect(opts.model).toBe("sonnet");
		expect(opts.files).toEqual([]);
	});

	it("accepts bare --ref and --model values", () => {
		const opts = parseArgs("--ref develop --model sonnet src/a.ts");
		expect(opts.ref).toBe("develop");
		expect(opts.explicitRef).toBe(true);
		expect(opts.model).toBe("sonnet");
		expect(opts.files).toEqual(["src/a.ts"]);
	});

	it("throws for bare --ref without a value", () => {
		expect(() => parseArgs("--ref --staged")).toThrow("--ref requires a value");
	});

	it("accepts --validate to opt into the validator stage", () => {
		const opts = parseArgs("--validate");
		expect(opts.validate).toBe(true);
	});

	it("defaults validate to false when not passed", () => {
		const opts = parseArgs("--all");
		expect(opts.validate).toBe(false);
	});
});

describe("tokenizeArgs", () => {
	it("returns an empty array for blank input", () => {
		expect(tokenizeArgs("   ")).toEqual([]);
	});

	it("handles single quotes and consecutive spaces", () => {
		expect(tokenizeArgs("--ref  'feature branch'   src/a.ts")).toEqual([
			"--ref",
			"feature branch",
			"src/a.ts",
		]);
	});

	it("handles backslash escapes outside and inside quotes", () => {
		expect(tokenizeArgs('src/my\\ file.ts "a\\"b"')).toEqual([
			"src/my file.ts",
			'a"b',
		]);
	});

	it("throws on unmatched quotes", () => {
		expect(() => tokenizeArgs('"src/a.ts')).toThrow("Unmatched");
	});
});

describe("drykiss_autoreview tool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolves a scope and returns the stable ReviewResult from the manager", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		const ctx = {
			cwd: "/tmp/test",
			modelRegistry: { getAvailable: vi.fn().mockReturnValue([]) },
		} as any;
		const pi = { exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any;
		const manager = {
			runReview: vi.fn().mockResolvedValue({
				jobId: "job-1",
				clean: true,
				status: "done",
				verdict: "Approve",
				target: { mode: "local", label: "local changes" },
				files: ["src/a.ts"],
				counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
				findings: [],
				summary: "Clean.",
				errors: [],
				validationIssues: [],
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			}),
		} as any;

		const result = await executeDrykissAutoreviewTool(
			{ mode: "local", lenses: ["security"], maxFiles: 5 },
			ctx,
			pi,
			manager,
			undefined,
			vi.fn(),
		);

		expect(manager.runReview).toHaveBeenCalledWith(
			ctx,
			pi,
			"/tmp/test",
			expect.arrayContaining([expect.objectContaining({ path: "src/a.ts" })]),
			expect.any(Map),
			expect.any(Map),
			undefined,
			expect.objectContaining({
				lenses: ["security"],
				target: expect.objectContaining({ label: "local changes" }),
			}),
			undefined,
		);
		expect(result.details.result.clean).toBe(true);
		expect(result.content[0].text).toContain("DRYKISS autoreview clean");
	});

	it("enforces maxFiles before running the manager", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
			{ path: "src/b.ts", status: "modified", language: "TypeScript" },
		]);
		const manager = { runReview: vi.fn() } as any;

		await expect(
			executeDrykissAutoreviewTool(
				{ mode: "local", maxFiles: 1 },
				{ cwd: "/tmp/test" } as any,
				{ exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any,
				manager,
			),
		).rejects.toThrow("over the maxFiles limit");
		expect(manager.runReview).not.toHaveBeenCalled();
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
				setWidget: vi.fn(),
				setEditorText: vi.fn(),
			},
			modelRegistry: {
				getAvailable: vi
					.fn()
					.mockReturnValue([{ name: "mock", id: "mock", provider: "mock" }]),
			},
			sessionManager: {
				getBranch: vi.fn().mockReturnValue([]),
			},
			hasUI: true,
		};

		mockPi = {
			exec: vi.fn().mockResolvedValue({ stdout: "" }),
			appendEntry: vi.fn(),
		};
		clearReviewSession(mockPi, mockCtx);

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

	it("handles prepareReview throwing from getChangedFiles (no unhandled rejection)", async () => {
		// Regression: prior to wrapping prepareReview in try/catch, if
		// getChangedFiles (or any other step inside prepareReview) threw,
		// the rejection propagated out of handleDrykissCommand as an
		// unhandled promise rejection. Now we catch it and show a clear
		// "Failed to prepare review" notification.
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockRejectedValue(
			new Error("git diff exploded"),
		);

		// Spy on unhandled rejections on the test process so we can assert
		// that this call doesn't trigger one. Use a process-level listener
		// that's removed in cleanup.
		const handler = vi.fn();
		process.on("unhandledRejection", handler);
		try {
			await handleDrykissCommand("", mockCtx, mockPi, mockManager);
			expect(handler).not.toHaveBeenCalled();
		} finally {
			process.removeListener("unhandledRejection", handler);
		}

		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Failed to prepare review"),
			"error",
		);
		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("git diff exploded"),
			"error",
		);
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

	it("reports parse errors without starting a review", async () => {
		await handleDrykissCommand('"unterminated', mockCtx, mockPi, mockManager);

		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Invalid arguments"),
			"error",
		);
		expect(mockManager.startReview).not.toHaveBeenCalled();
	});

	it("starts an isolated review branch when requested", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);
		mockCtx.sessionManager = makeReviewSessionManager();
		mockCtx.navigateTree = vi.fn().mockResolvedValue({ cancelled: false });

		await handleDrykissCommand("--branch", mockCtx, mockPi, mockManager);

		expect(mockCtx.navigateTree).toHaveBeenCalledWith("user-1", {
			summarize: false,
			label: "drykiss-review",
		});
		expect(mockPi.appendEntry).toHaveBeenCalledWith("drykiss-review-session", {
			active: true,
			originId: "origin-1",
		});
		expect(mockManager.startReview).toHaveBeenCalled();
		expect(mockCtx.ui.setWidget).toHaveBeenCalledWith("drykiss-review", [
			"DRYKISS review in progress",
		]);
	});

	it("cleans up an isolated review branch when review start fails", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);
		mockCtx.sessionManager = makeReviewSessionManager();
		mockCtx.navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
		mockManager.startReview.mockRejectedValue(new Error("Model not found"));

		await handleDrykissCommand("--branch", mockCtx, mockPi, mockManager);

		expect(mockCtx.navigateTree).toHaveBeenCalledWith("origin-1", {
			summarize: false,
		});
		expect(mockPi.appendEntry).toHaveBeenCalledWith("drykiss-review-session", {
			active: false,
			originId: undefined,
		});
		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("DRYKISS review failed: Model not found"),
			"error",
		);
	});

	it("cleans up an isolated review branch when confirmation is declined", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);
		mockCtx.sessionManager = makeReviewSessionManager();
		mockCtx.navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
		mockCtx.ui.confirm.mockResolvedValue(false);

		await handleDrykissCommand("--branch", mockCtx, mockPi, mockManager);

		expect(mockCtx.navigateTree).toHaveBeenCalledWith("origin-1", {
			summarize: false,
		});
		expect(mockManager.startReview).not.toHaveBeenCalled();
		expect(mockCtx.ui.notify).toHaveBeenCalledWith("Review cancelled.", "info");
	});

	it("ends an isolated review branch", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);
		mockCtx.sessionManager = makeReviewSessionManager();
		mockCtx.navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
		await handleDrykissCommand("--branch", mockCtx, mockPi, mockManager);
		vi.clearAllMocks();

		await handleEndReviewCommand("", mockCtx, mockPi);

		expect(mockCtx.navigateTree).toHaveBeenCalledWith("origin-1", {
			summarize: false,
		});
		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			"DRYKISS review session ended. Returned to original position.",
			"info",
		);
	});

	it("warns when ending a review branch but none is active", async () => {
		await handleEndReviewCommand("", mockCtx, mockPi);

		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Not in a DRYKISS review session"),
			"warning",
		);
	});

	it("reports navigation errors while ending a review branch", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "test.ts", status: "modified", language: "TypeScript" },
		]);
		mockCtx.sessionManager = makeReviewSessionManager();
		mockCtx.navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
		await handleDrykissCommand("--branch", mockCtx, mockPi, mockManager);
		mockCtx.navigateTree.mockRejectedValueOnce(new Error("nav failed"));
		vi.clearAllMocks();

		await handleEndReviewCommand("", mockCtx, mockPi);

		expect(mockCtx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Failed to end review session: nav failed"),
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

	it("includes health score and quality gate in autoreview output", async () => {
		const { executeDrykissAutoreviewTool } = await import(
			"./review-command.js"
		);
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		(mockManager as any).runReview = vi.fn().mockResolvedValue({
			jobId: "job-1",
			clean: false,
			status: "done",
			verdict: "Request changes",
			target: { mode: "local", label: "local changes" },
			files: ["src/a.ts"],
			counts: { total: 2, critical: 1, high: 1, medium: 0, low: 0, nit: 0 },
			findings: [
				{
					file: "src/a.ts",
					severity: "critical",
					category: "Bug",
					summary: "x",
					detail: "x",
					suggestion: "x",
					confidence: "confirmed",
				},
				{
					file: "src/a.ts",
					severity: "high",
					category: "Bug",
					summary: "y",
					detail: "y",
					suggestion: "y",
					confidence: "confirmed",
				},
			],
			summary: "Issues found.",
			errors: [],
			validationIssues: [],
			healthScore: 60,
			scoreBreakdown: { critical: 1, warning: 1, suggestion: 0 },
			prevScore: 80,
		});

		const result = await executeDrykissAutoreviewTool(
			{ mode: "local", lenses: ["security"], maxFiles: 5 },
			mockCtx,
			mockPi,
			mockManager,
			undefined,
			vi.fn(),
		);

		const text = result.content[0].text;
		expect(text).toContain("health score: 60/100");
		expect(text).toContain("trend: 80 → 60");
		expect(text).toContain("⛔ quality gate: FAIL");
	});

	it("includes mermaidGraph in autoreview output when present", async () => {
		const { executeDrykissAutoreviewTool } = await import(
			"./review-command.js"
		);
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		(mockManager as any).runReview = vi.fn().mockResolvedValue({
			jobId: "job-2",
			clean: true,
			status: "done",
			verdict: "Approve",
			target: { mode: "full", label: "full scan" },
			files: ["src/a.ts"],
			counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
			findings: [],
			summary: "Clean.",
			errors: [],
			validationIssues: [],
			healthScore: 100,
			scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			mermaidGraph: "graph TD\n  A[a.ts]\n  B[b.ts]",
		});

		const result = await executeDrykissAutoreviewTool(
			{
				mode: "files",
				files: ["src/a.ts"],
				lenses: ["architecture"],
				maxFiles: 5,
			},
			mockCtx,
			mockPi,
			mockManager,
			undefined,
			vi.fn(),
		);

		const text = result.content[0].text;
		expect(text).toContain("=== Dependency Graph ===");
		expect(text).toContain("graph TD");
	});
});
