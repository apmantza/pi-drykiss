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
const formatReviewForDisplay = vi.fn(() => "formatted review");
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

vi.mock("./persist.js", () => ({
	listReviews: vi.fn().mockResolvedValue([]),
	formatReviewForDisplay,
}));

const commandExports = {
	handleDrykissCommand: vi.fn(),
	handleKissCommand: vi.fn(),
	handleDryCommand: vi.fn(),
	handleResilienceCommand: vi.fn(),
	handleArchCommand: vi.fn(),
	handleTestsCommand: vi.fn(),
	handleSecurityCommand: vi.fn(),
	handleJobsCommand: vi.fn(),
	handleEndReviewCommand: vi.fn(),
	executeDrykissReviewTool: vi.fn(),
	executeDrykissAutoreviewTool: vi.fn(),
	DrykissReviewParams: {},
	DrykissAutoreviewParams: {},
	COMMAND_NAME: "drykiss",
	KISS_COMMAND_NAME: "drykiss-kiss",
	DRY_COMMAND_NAME: "drykiss-dry",
	RESILIENCE_COMMAND_NAME: "drykiss-resilience",
	ARCH_COMMAND_NAME: "drykiss-arch",
	TESTS_COMMAND_NAME: "drykiss-tests",
	SECURITY_COMMAND_NAME: "drykiss-security",
};

vi.mock("./review-command.js", () => commandExports);
vi.mock("./config-command.js", () => ({
	handleConfigCommand: vi.fn(),
	handleSuppressCommand: vi.fn(),
	handleListSuppressionsCommand: vi.fn(),
	handleUnsuppressCommand: vi.fn(),
}));

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

describe("extension event wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		managerOnComplete = undefined;
		managerListJobs.mockReturnValue([]);
		trackerGetLastTurnEdits.mockReturnValue(null);
		trackerTrackEdit.mockReturnValue(undefined);
		buildAutoInjectBlock.mockReturnValue("\nAUTO-INJECT");
		formatReviewForDisplay.mockReturnValue("formatted review");
		loadConfig.mockResolvedValue({});
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

	it("renders completed review messages with serialized lens state", () => {
		const { pi } = makePi();
		registerDrykiss(pi as any);
		const renderer = pi.registerMessageRenderer.mock.calls.find(
			([type]) => type === "drykiss-review-complete",
		)?.[1];
		const theme = {
			fg: (_name: string, value: string) => value,
			bold: (value: string) => value,
		};

		expect(() =>
			renderer(
				{
					details: {
						files: [],
						lenses: ["tests"],
						states: { tests: { status: "error", errorMessage: "boom" } },
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
					},
				},
				{ expanded: false },
				theme,
			),
		).not.toThrow();
	});

	it("renders completed review messages with malformed synthesis fields", () => {
		const { pi } = makePi();
		registerDrykiss(pi as any);
		const renderer = pi.registerMessageRenderer.mock.calls.find(
			([type]) => type === "drykiss-review-complete",
		)?.[1];
		const theme = {
			fg: (_name: string, value: string) => value,
			bold: (value: string) => value,
		};

		expect(() =>
			renderer(
				{
					details: {
						files: "not-files",
						lenses: "not-lenses",
						states: {},
						startedAt: "not-a-date",
						overallStatus: "done",
						synthesisResult: {
							findings: "not-findings",
							summary: undefined,
							verdict: 123,
							criticalCount: "1",
							highCount: null,
						},
					},
				},
				{ expanded: true },
				theme,
			),
		).not.toThrow();
	});

	it("renders a fallback when expanded review formatting fails", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { pi } = makePi();
			registerDrykiss(pi as any);
			const renderer = pi.registerMessageRenderer.mock.calls.find(
				([type]) => type === "drykiss-review-complete",
			)?.[1];
			const theme = {
				fg: (_name: string, value: string) => value,
				bold: (value: string) => value,
			};
			formatReviewForDisplay.mockImplementationOnce(() => {
				throw new Error("format failed");
			});

			expect(() =>
				renderer(
					{
						details: completedJob(),
					},
					{ expanded: true },
					theme,
				),
			).not.toThrow();
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("Failed rendering expanded review report"),
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
		expect(pi.sendMessage).toHaveBeenCalled();
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

	it("resets review-in-progress state when completion notification throws", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { pi, handlers } = makePi();
			registerDrykiss(pi as any);
			const ctx = makeCtx();
			handlers.get("session_start")?.({}, ctx);
			vi.clearAllMocks();
			managerListJobs.mockReturnValue([]);
			pi.sendMessage.mockImplementationOnce(() => {
				throw new Error("send failed");
			});

			managerOnComplete?.(completedJob());

			expect(setReviewInProgress).toHaveBeenCalledWith(false);
			expect(applyReviewState).toHaveBeenCalledWith(ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Failed sending review notification"),
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
