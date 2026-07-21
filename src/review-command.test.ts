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
const { executeDrykissAutoreviewTool } = await import("./review-command.js");

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
			cwd: "/home/test",
			modelRegistry: { getAvailable: vi.fn().mockReturnValue([]) },
		} as any;
		const pi = { exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any;
		const manager = {
			recordFinalResult: vi.fn(),
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
			"/home/test",
			expect.arrayContaining([expect.objectContaining({ path: "src/a.ts" })]),
			expect.any(Map),
			expect.any(Map),
			undefined,
			expect.objectContaining({
				lenses: ["security"],
				validate: undefined,
				target: expect.objectContaining({ label: "local changes" }),
			}),
			undefined,
		);
		expect(result.details.result!.clean).toBe(true);
		expect(manager.recordFinalResult).toHaveBeenCalledWith(
			result.details.result!,
		);
		// Default format is "compact": one-line header, kiss-style.
		expect(result.content[0].text).toMatch(/^DRYKISS clean /m);
		expect(result.content[0].text).toContain("local changes");
	});

	it("returns a job ID and continues a background review", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		const { getBackgroundReview } = await import("./background-review.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		const notify = vi.fn();
		const ctx = {
			cwd: "/home/test",
			modelRegistry: { getAvailable: vi.fn().mockReturnValue([]) },
			ui: { notify },
		} as any;
		const manager = {
			recordFinalResult: vi.fn(),
			runReview: vi.fn().mockResolvedValue({
				jobId: "job-background",
				clean: true,
				status: "done",
				reviewStatus: "done",
				codeRisk: "clean",
				qualityGate: { status: "pass", threshold: 70, score: 100, reasons: [] },
				verdict: "Approve",
				verdictSource: "deterministic",
				target: { mode: "local", label: "local changes" },
				files: ["src/a.ts"],
				counts: {
					total: 0,
					critical: 0,
					high: 0,
					medium: 0,
					low: 0,
					nit: 0,
					suppressed: 0,
					previouslyRejected: 0,
				},
				findings: [],
				summary: "Clean.",
				errors: [],
				validationIssues: [],
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			}),
		} as any;

		const response = await executeDrykissAutoreviewTool(
			{ mode: "local", lens: "security", background: true },
			ctx,
			{ exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any,
			manager,
		);

		const background = response.details.background;
		expect(background?.status).toBe("running");
		expect(response.content[0].text).toContain("local · security");
		expect(response.content[0].text).toContain(
			"completion notification will follow",
		);
		expect(response.content[0].text).toContain(`job ${background?.id}`);
		await vi.waitFor(() => expect(manager.runReview).toHaveBeenCalled());
		const completed = getBackgroundReview(background!.id);
		expect(completed?.status).toBe("done");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("background review complete"),
			"info",
		);
		expect(notify.mock.calls[0][0]).toContain("Verdict: Approve");
	});

	it("uses single `lens` param to select one lens", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		const pi = { exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any;
		const manager = {
			recordFinalResult: vi.fn(),
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

		await executeDrykissAutoreviewTool(
			{ mode: "local", lens: "resilience" },
			{ cwd: "/home/test", modelRegistry: { getAvailable: vi.fn() } } as any,
			pi,
			manager,
		);

		expect(manager.runReview).toHaveBeenCalledTimes(1);
		// Argument index 7 is the options object.
		expect(manager.runReview.mock.calls[0][7]).toEqual(
			expect.objectContaining({ lenses: ["resilience"] }),
		);
	});

	it("`lens` param with 'all' runs all lenses", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		const pi = { exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any;
		const manager = {
			recordFinalResult: vi.fn(),
			runReview: vi.fn().mockResolvedValue({
				jobId: "job-1",
				clean: true,
				status: "done",
				verdict: "Approve",
				findings: [],
				counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
				summary: "Clean.",
				errors: [],
				validationIssues: [],
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			}),
		} as any;

		await executeDrykissAutoreviewTool(
			{ mode: "local", lens: "all" },
			{ cwd: "/home/test", modelRegistry: { getAvailable: vi.fn() } } as any,
			pi,
			manager,
		);

		expect(manager.runReview).toHaveBeenCalledTimes(1);
		const args = manager.runReview.mock.calls[0][7] as any;
		const sortByName = (a: string, b: string) => a.localeCompare(b);
		expect(args.lenses.sort(sortByName)).toEqual(
			[
				"simplicity",
				"deduplication",
				"clarity",
				"resilience",
				"architecture",
				"tests",
				"security",
				"docs",
			].sort(sortByName),
		);
	});

	it("`lens` overrides `lenses` when both are set", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		const pi = { exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any;
		const manager = {
			recordFinalResult: vi.fn(),
			runReview: vi.fn().mockResolvedValue({
				jobId: "job-1",
				clean: true,
				status: "done",
				verdict: "Approve",
				findings: [],
				counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
				summary: "Clean.",
				errors: [],
				validationIssues: [],
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			}),
		} as any;

		await executeDrykissAutoreviewTool(
			{
				mode: "local",
				lens: "security",
				lenses: ["simplicity", "architecture"],
			},
			{ cwd: "/home/test", modelRegistry: { getAvailable: vi.fn() } } as any,
			pi,
			manager,
		);

		expect(manager.runReview).toHaveBeenCalledTimes(1);
		expect(manager.runReview.mock.calls[0][7]).toEqual(
			expect.objectContaining({ lenses: ["security"] }),
		);
	});

	it("caps maxFiles before running the manager", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
			{ path: "src/b.ts", status: "modified", language: "TypeScript" },
		]);
		const manager = {
			recordFinalResult: vi.fn(),
			runReview: vi.fn().mockResolvedValue({
				jobId: "job-1",
				clean: true,
				status: "done",
				verdict: "Approve",
				target: { mode: "local", label: "local changes (first 1 of 2 files)" },
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

		await executeDrykissAutoreviewTool(
			{ mode: "local", maxFiles: 1 },
			{ cwd: "/home/test" } as any,
			{ exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any,
			manager,
		);

		expect(manager.runReview).toHaveBeenCalled();
		expect(manager.runReview.mock.calls[0][3]).toEqual([
			expect.objectContaining({ path: "src/a.ts" }),
		]);
		expect(manager.runReview.mock.calls[0][7].target).toEqual(
			expect.objectContaining({
				label: "local changes (first 1 of 2 files)",
				metadata: expect.objectContaining({
					cappedFromFileCount: 2,
					maxFiles: 1,
				}),
			}),
		);
	});

	it("does not fail the tool when final result recording fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { getChangedFiles } = await import("./git-diff.js");
			vi.mocked(getChangedFiles).mockResolvedValue([
				{ path: "src/a.ts", status: "modified", language: "TypeScript" },
			]);
			const manager = {
				recordFinalResult: vi.fn(() => {
					throw new Error("record failed");
				}),
				runReview: vi.fn().mockResolvedValue({
					jobId: "job-1",
					clean: true,
					status: "done",
					verdict: "Approve",
					files: ["src/a.ts"],
					counts: {
						total: 0,
						critical: 0,
						high: 0,
						medium: 0,
						low: 0,
						nit: 0,
						suppressed: 0,
						previouslyRejected: 0,
					},
					findings: [],
					summary: "Clean.",
					errors: [],
					validationIssues: [],
					healthScore: 100,
					scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
				}),
			} as any;

			const result = await executeDrykissAutoreviewTool(
				{ mode: "local" },
				{ cwd: "/home/test", modelRegistry: { getAvailable: vi.fn() } } as any,
				{ exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any,
				manager,
			);

			expect(result.details.result!.clean).toBe(true);
			expect(warn).toHaveBeenCalledWith(
				"%s Failed to record final review result:",
				"[DRYKISS]",
				expect.any(Error),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("renders a progress bar and running model names via onUpdate", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]);
		const onUpdate = vi.fn();
		const manager = {
			recordFinalResult: vi.fn(),
			runReview: vi.fn().mockImplementation((...args: any[]) => {
				const options = args[7];
				if (options?.onProgress) {
					options.onProgress({
						id: "job-1",
						files: ["src/a.ts"],
						lenses: ["simplicity", "security"],
						states: new Map([
							[
								"simplicity",
								{
									status: "done",
									modelName: "claude-3-haiku",
									provider: "anthropic",
									durationMs: 100,
									findingsCount: 0,
									rawOutput: "[]",
								},
							],
							[
								"security",
								{
									status: "running",
									modelName: "gpt-4o-mini",
									provider: "openai",
									durationMs: 0,
									findingsCount: 0,
									rawOutput: "[]",
									startedAt: Date.now() - 300,
								},
							],
						]),
						synthesisStatus: "idle",
						overallStatus: "running",
						startedAt: Date.now() - 500,
					} as any);
				}
				return Promise.resolve({
					jobId: "job-1",
					clean: true,
					status: "done",
					verdict: "Approve",
					findings: [],
					counts: {
						total: 0,
						critical: 0,
						high: 0,
						medium: 0,
						low: 0,
						nit: 0,
						suppressed: 0,
						previouslyRejected: 0,
						validatorReal: 0,
						validatorFalsePositive: 0,
						validatorUnverified: 0,
					},
					summary: "Clean.",
					errors: [],
					validationIssues: [],
					healthScore: 100,
					scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
				});
			}),
		} as any;

		await executeDrykissAutoreviewTool(
			{ mode: "local" },
			{ cwd: "/home/test", modelRegistry: { getAvailable: vi.fn() } } as any,
			{ exec: vi.fn().mockResolvedValue({ stdout: "" }) } as any,
			manager,
			undefined,
			onUpdate,
		);

		const scopingCalls = onUpdate.mock.calls.filter(
			(call) => call[0].details?.phase === "scoping",
		);
		expect(scopingCalls.length).toBeGreaterThan(0);
		expect(scopingCalls[0][0].content[0].text).toMatch(/[█+]/);
		expect(scopingCalls[0][0].content[0].text).toContain("1/1 (100%)");

		const progressCalls = onUpdate.mock.calls.filter((call) =>
			call[0].content[0].text.includes("DRYKISS autoreview progress:"),
		);
		expect(progressCalls.length).toBeGreaterThan(0);
		const lastProgress = progressCalls.at(-1)![0].content[0].text as string;
		expect(lastProgress).toMatch(/[█+░+]/); // progress bar rendered
		expect(lastProgress).toContain("1/2 lens(es) complete");
		expect(lastProgress).toContain("security (openai/gpt-4o-mini)");
	});
});

describe("tool parameter schemas (LLM-facing surface)", () => {
	it("DrykissAutoreviewParams exposes scope + lens + lenses + background + format", async () => {
		const { DrykissAutoreviewParams } = await import("./review-command.js");
		const props = Object.keys((DrykissAutoreviewParams as any).properties);
		// `lens` was added when the separate drykiss_review tool was
		// consolidated into drykiss_autoreview. Accepts a single lens
		// name or "all". Overrides `lenses` if both are set.
		expect(props.sort((a, b) => a.localeCompare(b))).toEqual(
			[
				"mode",
				"files",
				"base",
				"commit",
				"pr",
				"lens",
				"lenses",
				"background",
				"format",
				"postToPr",
			].sort((a, b) => a.localeCompare(b)),
		);
	});

	it("DrykissAutoreviewParams `mode` enum excludes 'auto' (smart default only)", async () => {
		const { DrykissAutoreviewParams } = await import("./review-command.js");
		const modeSchema = (DrykissAutoreviewParams as any).properties.mode;
		const literals = modeSchema.anyOf.map((s: any) => s.const);
		expect(literals).not.toContain("auto");
		expect(literals.sort((a: string, b: string) => a.localeCompare(b))).toEqual(
			["local", "staged", "branch", "commit", "pr", "full", "files"].sort(
				(a, b) => a.localeCompare(b),
			),
		);
	});

	it("DrykissAutoreviewParams `lens` param accepts single lens name or 'all'", async () => {
		const { DrykissAutoreviewParams } = await import("./review-command.js");
		const lensSchema = (DrykissAutoreviewParams as any).properties.lens;
		const literals = lensSchema.anyOf.map((s: any) => s.const);
		expect(literals).toContain("all");
		expect(literals).toContain("security");
		expect(literals).toContain("docs");
		expect(literals).toContain("simplicity");
	});
});
