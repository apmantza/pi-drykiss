import { beforeEach, describe, expect, it, vi } from "vitest";

const applyReviewState = vi.fn();
const setReviewInProgress = vi.fn();
const widgetAttach = vi.fn();
const widgetSetJobs = vi.fn();
const trackerGetLastTurnEdits = vi.fn();
const trackerClearLastTurnEdits = vi.fn();
const trackerTrackEdit = vi.fn();
const trackerOnTurnEnd = vi.fn();
const managerListJobs = vi.fn();
const managerStartCleanup = vi.fn();
const buildAutoInjectBlock = vi.fn(() => "\nAUTO-INJECT");
const loadConfig = vi.fn().mockResolvedValue({});
let managerOnComplete: ((job: any) => void) | undefined;

vi.mock("./review-session.js", () => ({
	applyReviewState,
	setReviewInProgress,
}));

vi.mock("./review-widget.js", () => ({
	ReviewProgressWidget: vi.fn().mockImplementation(() => ({
		attach: widgetAttach,
		setJobs: widgetSetJobs,
	})),
	// Aggregators consumed by the TUI widget's completed summary.
	// The real implementations are pure functions over lens-state
	// entries; the test stubs return empty arrays because the test
	// fixtures don't exercise these paths.
	collectModelPairs: vi.fn(() => []),
	pickVerdict: vi.fn((synthesisVerdict: unknown, hasError: boolean) =>
		typeof synthesisVerdict === "string" && synthesisVerdict.length > 0
			? synthesisVerdict
			: hasError
				? "Review failed"
				: "Request changes",
	),
}));

vi.mock("./review-manager.js", () => ({
	ReviewManager: vi.fn().mockImplementation((_onUpdate, onComplete) => {
		managerOnComplete = onComplete;
		return {
			listJobs: managerListJobs,
			startCleanup: managerStartCleanup,
		};
	}),
}));

vi.mock("./edit-tracker.js", () => ({
	createEditTracker: vi.fn(() => ({
		getLastTurnEdits: trackerGetLastTurnEdits,
		clearLastTurnEdits: trackerClearLastTurnEdits,
		trackEdit: trackerTrackEdit,
		onTurnEnd: trackerOnTurnEnd,
	})),
}));

vi.mock("./auto-inject.js", () => ({
	buildAutoInjectBlock,
}));

const toolExports = {
	executeDrykissAutoreviewTool: vi.fn(),
	DrykissAutoreviewParams: {},
};

vi.mock("./review-command.js", () => toolExports);

const { default: registerDrykiss } = await import("./index.js");

function makePi() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on: vi.fn((event: string, handler: (...args: any[]) => any) => {
			handlers.set(event, handler);
		}),
		registerMessageRenderer: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		sendMessage: vi.fn(),
	};
	return { pi, handlers };
}

function makeCtx() {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
		},
	} as any;
}

function completedJob() {
	return {
		files: [],
		lenses: [],
		states: new Map(),
		startedAt: Date.now(),
		overallStatus: "done",
		synthesisResult: {
			findings: [],
			summary: "clean",
			verdict: "Approve",
			criticalCount: 0,
			highCount: 0,
			mediumCount: 0,
			lowCount: 0,
			nitCount: 0,
		},
	};
}

describe("extension registration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		managerOnComplete = undefined;
		managerListJobs.mockReturnValue([]);
		trackerGetLastTurnEdits.mockReturnValue(null);
		trackerTrackEdit.mockReturnValue(undefined);
		buildAutoInjectBlock.mockReturnValue("\nAUTO-INJECT");
		loadConfig.mockResolvedValue({});
	});

	it("registers review, status, and cancel tools, no commands", () => {
		const { pi } = makePi();
		registerDrykiss(pi as any);

		expect(pi.registerCommand).not.toHaveBeenCalled();
		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "drykiss_autoreview" }),
		);
		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "drykiss_autoreview_status" }),
		);
		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "drykiss_autoreview_cancel" }),
		);
	});

	it("attaches the review widget on tool execution start", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);
		const ctx = makeCtx();

		handlers.get("tool_execution_start")?.({}, ctx);

		expect(widgetAttach).toHaveBeenCalledWith(ctx.ui);
		expect(widgetSetJobs).toHaveBeenCalledWith([]);
	});

	it("restores review state on session_start and session_tree", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);
		const ctx = makeCtx();

		handlers.get("session_start")?.({}, ctx);
		handlers.get("session_tree")?.({}, ctx);

		expect(widgetAttach).toHaveBeenCalledWith(ctx.ui);
		expect(applyReviewState).toHaveBeenCalledWith(ctx);
		expect(applyReviewState).toHaveBeenCalledTimes(2);
	});

	it("tracks edited files on tool execution end", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);
		const ctx = makeCtx();
		trackerTrackEdit.mockReturnValue({
			path: "src/a.ts",
			language: "TypeScript",
		});

		handlers.get("tool_execution_end")?.(
			{
				toolName: "edit",
				result: { path: "src/a.ts" },
				args: { path: "src/a.ts" },
			},
			ctx,
		);

		expect(trackerTrackEdit).toHaveBeenCalledWith(
			"edit",
			{ path: "src/a.ts" },
			{ path: "src/a.ts" },
		);
	});

	it("finalizes edit tracking on turn end", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);

		handlers.get("turn_end")?.({ turnIndex: 42 }, makeCtx());

		expect(trackerOnTurnEnd).toHaveBeenCalledWith(42);
	});

	it("warns instead of throwing when edit tracking fails", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { pi, handlers } = makePi();
			registerDrykiss(pi as any);
			const ctx = makeCtx();
			trackerTrackEdit.mockImplementationOnce(() => {
				throw new Error("track failed");
			});

			expect(() =>
				handlers.get("tool_execution_end")?.({ toolName: "edit" }, ctx),
			).not.toThrow();
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed tracking file edit"),
				"warning",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("warns instead of throwing when turn-end tracking fails", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { pi, handlers } = makePi();
			registerDrykiss(pi as any);
			const ctx = makeCtx();
			trackerOnTurnEnd.mockImplementationOnce(() => {
				throw new Error("turn failed");
			});

			expect(() =>
				handlers.get("turn_end")?.({ turnIndex: 42 }, ctx),
			).not.toThrow();
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed finalizing edit tracking"),
				"warning",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("adds auto-inject content before agent start when edits exist", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);
		trackerGetLastTurnEdits.mockReturnValue({
			files: [{ path: "src/a.ts", language: "TypeScript" }],
			turnIndex: 1,
		});

		const result = handlers.get("before_agent_start")?.({
			systemPrompt: "base",
		});

		expect(result).toEqual({ systemPrompt: "base\nAUTO-INJECT" });
		expect(trackerClearLastTurnEdits).toHaveBeenCalled();
	});

	it("returns undefined before agent start when there are no edits", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);

		const result = handlers.get("before_agent_start")?.({
			systemPrompt: "base",
		});

		expect(result).toBeUndefined();
		expect(trackerClearLastTurnEdits).not.toHaveBeenCalled();
	});

	it("returns undefined before agent start when auto-inject building fails", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { pi, handlers } = makePi();
			registerDrykiss(pi as any);
			const ctx = makeCtx();
			trackerGetLastTurnEdits.mockReturnValue({ files: [], turnIndex: 1 });
			buildAutoInjectBlock.mockImplementationOnce(() => {
				throw new Error("inject failed");
			});

			const result = handlers.get("before_agent_start")?.(
				{ systemPrompt: "base" },
				ctx,
			);

			expect(result).toBeUndefined();
			expect(trackerClearLastTurnEdits).not.toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed building auto-inject prompt"),
				"warning",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("resets review-in-progress state when the last review completes", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);
		const ctx = makeCtx();
		handlers.get("session_start")?.({}, ctx);
		vi.clearAllMocks();
		managerListJobs.mockReturnValue([]);

		managerOnComplete?.(completedJob());

		expect(setReviewInProgress).toHaveBeenCalledWith(false);
		expect(applyReviewState).toHaveBeenCalledWith(ctx);
	});

	it("still resets review-in-progress state when completion widget update fails", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { pi, handlers } = makePi();
			registerDrykiss(pi as any);
			const ctx = makeCtx();
			handlers.get("session_start")?.({}, ctx);
			vi.clearAllMocks();
			managerListJobs.mockReturnValue([]);
			widgetSetJobs.mockImplementationOnce(() => {
				throw new Error("widget failed");
			});

			managerOnComplete?.(completedJob());

			expect(setReviewInProgress).toHaveBeenCalledWith(false);
			expect(applyReviewState).toHaveBeenCalledWith(ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed handling completed review"),
				"warning",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("resets review-in-progress state if completion job listing fails", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { pi, handlers } = makePi();
			registerDrykiss(pi as any);
			const ctx = makeCtx();
			handlers.get("session_start")?.({}, ctx);
			vi.clearAllMocks();
			managerListJobs.mockImplementationOnce(() => {
				throw new Error("list failed");
			});

			managerOnComplete?.(completedJob());

			expect(setReviewInProgress).toHaveBeenCalledWith(false);
			expect(applyReviewState).toHaveBeenCalledWith(ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed handling completed review"),
				"warning",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not reset review-in-progress state while another review is running", () => {
		const { pi, handlers } = makePi();
		registerDrykiss(pi as any);
		const ctx = makeCtx();
		handlers.get("session_start")?.({}, ctx);
		vi.clearAllMocks();
		managerListJobs.mockReturnValue([{ overallStatus: "running" }]);

		managerOnComplete?.({
			files: [],
			lenses: [],
			states: new Map(),
			startedAt: Date.now(),
			overallStatus: "done",
		});

		expect(setReviewInProgress).not.toHaveBeenCalled();
		expect(applyReviewState).not.toHaveBeenCalled();
	});
});

describe("drykiss_autoreview tool renderResult", () => {
	function getTool() {
		const { pi } = makePi();
		registerDrykiss(pi as any);
		return pi.registerTool.mock.calls[0][0];
	}

	function render(result: any, isPartial = false): string {
		const tool = getTool();
		const theme = {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
			dim: (t: string) => t,
		};
		const text = tool.renderResult(result, { isPartial }, theme);
		return text.render(200).join("\n");
	}

	it("renders the verdict + score for a final clean result", () => {
		const out = render({
			details: {
				result: {
					clean: true,
					counts: { total: 0 },
					verdict: "Approve",
					healthScore: 95,
				},
			},
		});
		expect(out).toContain("clean");
		expect(out).toContain("0 finding(s)");
		expect(out).toContain("verdict: Approve");
		expect(out).toContain("score 95/100");
	});

	it("renders the verdict + score for a final result with findings", () => {
		const out = render({
			details: {
				result: {
					clean: false,
					counts: { total: 3 },
					verdict: "Request changes",
					healthScore: 42,
				},
			},
		});
		expect(out).toContain("reviewed");
		expect(out).toContain("3 finding(s)");
		expect(out).toContain("verdict: Request changes");
		expect(out).toContain("score 42/100");
	});

	it("persists result details instead of the last progress line", () => {
		const out = render({
			details: {
				progress:
					"DRYKISS autoreview progress: [██████████] 1/1 lens(es) complete",
				result: {
					clean: false,
					status: "done",
					target: { label: "full codebase" },
					counts: {
						total: 2,
						critical: 0,
						high: 1,
						medium: 1,
						low: 0,
						nit: 0,
						suppressed: 1,
						previouslyRejected: 1,
						validatorFalsePositive: 1,
					},
					verdict: "Request changes",
					healthScore: 55,
					reportPath: "/tmp/report.json",
				},
			},
		});

		expect(out).not.toContain("DRYKISS autoreview progress");
		expect(out).toContain("full codebase");
		expect(out).toContain("2 finding(s)");
		expect(out).toContain("1 high");
		expect(out).toContain("1 suppressed");
		expect(out).toContain("1 previously-rejected");
		expect(out).toContain("1 validator-refuted");
		expect(out).toContain("report: /tmp/report.json");
	});

	it("renders nothing for a partial/streaming result (widget handles live progress)", () => {
		const out = render(
			{
				details: {
					progress:
						"DRYKISS autoreview progress: [░░░░░░░░░░] 0/1 lens(es) complete",
				},
			},
			true,
		);
		expect(out).toBe("");
		expect(out).not.toContain("reviewed 0 finding(s)");
	});

	it("renders nothing for a partial result even with content text", () => {
		const out = render(
			{
				content: [{ type: "text", text: "Preparing review scope…" }],
			},
			true,
		);
		expect(out).toBe("");
		expect(out).not.toContain("Preparing review scope");
	});

	it("renders nothing for an empty partial result", () => {
		const out = render({}, true);
		expect(out).toBe("");
	});

	it("renders nothing for an unexpected non-partial shape without a result", () => {
		const out = render({ details: {} });
		expect(out).toBe("");
	});
});
