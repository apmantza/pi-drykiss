import { describe, expect, it } from "vitest";
import {
	ReviewProgressWidget,
	collectModelPairs,
	pickVerdict,
	formatFinding,
} from "./review-widget.js";
import type { LensState, ReviewJob } from "./review-manager.js";
import type { ReviewLens, Finding } from "./types.js";

function buildLensState(overrides: Partial<LensState>): LensState {
	return {
		status: "queued",
		modelName: "m",
		durationMs: 0,
		findingsCount: 0,
		rawOutput: "",
		...overrides,
	};
}

function renderLines(job: ReviewJob): string[] {
	let captured: (() => string[]) | undefined;
	const widget = new ReviewProgressWidget();
	const theme = {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};
	const uiCtx = {
		setWidget: (
			_key: string,
			fn: (tui: any, theme: any) => { render: () => string[] },
		) => {
			captured = () => fn({ terminal: { columns: 200 } }, theme).render();
		},
	};
	widget.attach(uiCtx);
	widget.setJobs([job]);
	const lines = captured?.() ?? [];
	widget.dispose();
	return lines;
}

function renderJobLine(job: ReviewJob, lineIndex = 1): string {
	return renderLines(job)[lineIndex] ?? "";
}

function buildRunningJob(elapsedMs: number): ReviewJob {
	const lens: ReviewLens = "simplicity";
	const state: LensState = {
		status: "running",
		modelName: "m",
		durationMs: 0,
		findingsCount: 0,
		rawOutput: "",
		startedAt: Date.now() - elapsedMs,
	};
	return {
		id: "j",
		files: [],
		lenses: [lens],
		states: new Map([[lens, state]]),
		synthesisStatus: "idle",
		overallStatus: "running",
		startedAt: Date.now() - elapsedMs,
	};
}

function renderElapsedLine(elapsedMs: number): string {
	const lines = renderLines(buildRunningJob(elapsedMs));
	// Running widget is now a single heading line with the elapsed.
	const heading = lines[0] ?? "";
	const match = heading.match(/running\s*(.+)$/);
	return match ? match[1].trim() : "";
}

describe("formatElapsed (via widget render)", () => {
	it("formats sub-minute durations as X.Ys", () => {
		expect(renderElapsedLine(500)).toBe("0.5s");
		expect(renderElapsedLine(12_300)).toBe("12.3s");
		expect(renderElapsedLine(59_900)).toBe("59.9s");
	});

	it("switches to Xm YYs at the one-minute mark", () => {
		expect(renderElapsedLine(60_000)).toBe("1m 00s");
		expect(renderElapsedLine(75_000)).toBe("1m 15s");
		expect(renderElapsedLine(125_000)).toBe("2m 05s");
	});

	it("switches to Xh YYm past one hour", () => {
		expect(renderElapsedLine(3_600_000)).toBe("1h 00m");
		expect(renderElapsedLine(3_900_000)).toBe("1h 05m");
	});

	it("renders 0.0s for a lens that just started", () => {
		expect(renderElapsedLine(0)).toBe("0.0s");
	});

	it("shows the heading line for running jobs", () => {
		const lines = renderLines(buildRunningJob(1000));
		expect(lines[0]).toContain("DRYKISS Review");
		expect(lines[0]).toContain("running");
	});

	it("shows a single progress line for running jobs (no per-lens lines)", () => {
		const lines = renderLines(buildRunningJob(1000));
		// Should be exactly 1 line: the progress heading.
		expect(lines).toHaveLength(1);
	});
});

describe("renderWidget — completed summary", () => {
	function buildCompletedJob(
		overrides: Partial<ReviewJob> & {
			synthesisResult?: any;
			overallStatus?: ReviewJob["overallStatus"];
		} = {},
	): ReviewJob {
		const lens: ReviewLens = "simplicity";
		const state: LensState = buildLensState({
			status: "done",
			durationMs: 4200,
			findingsCount: 3,
			modelName: "Claude Sonnet 4",
			provider: "anthropic",
		});
		return {
			id: "j3",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "done",
			overallStatus: overrides.overallStatus ?? "done",
			startedAt: Date.now() - 5000,
			completedAt: Date.now(),
			synthesisResult: overrides.synthesisResult ?? {
				findings: [],
				summary: "ok",
				verdict: "Approve",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				healthScore: 92,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			},
			...overrides,
		};
	}

	it("renders heading + per-lens line for a completed job", () => {
		const lines = renderLines(buildCompletedJob());
		// Line 0: heading with verdict
		expect(lines[0]).toContain("DRYKISS Review");
		expect(lines[0]).toContain("Verdict: Approve");
		// Line 1: per-lens line
		expect(lines[1]).toContain("KISS");
		expect(lines[1]).toContain("✓");
		expect(lines[1]).toContain("4.2s");
		expect(lines[1]).toContain("3 findings");
		expect(lines[1]).toContain("@ anthropic/Claude Sonnet 4");
	});

	it("includes critical/high counts in the severity breakdown line", () => {
		const lines = renderLines(
			buildCompletedJob({
				synthesisResult: {
					findings: [],
					summary: "needs work",
					verdict: "Request changes",
					criticalCount: 2,
					highCount: 5,
					mediumCount: 3,
					lowCount: 1,
					nitCount: 0,
					healthScore: 35,
					scoreBreakdown: { critical: 2, warning: 5, suggestion: 0 },
				},
			}),
		);
		// Severity breakdown is the last line.
		const breakdown = lines[lines.length - 1];
		expect(breakdown).toContain("2 critical");
		expect(breakdown).toContain("5 high");
		expect(breakdown).toContain("3 medium");
	});

	it("omits severity breakdown when no findings", () => {
		const lines = renderLines(buildCompletedJob());
		// Should be heading + 1 per-lens line, no breakdown.
		expect(lines).toHaveLength(2);
	});

	it("lists multiple per-lens lines for multi-lens jobs", () => {
		const lens1: ReviewLens = "simplicity";
		const lens2: ReviewLens = "deduplication";
		const job = buildCompletedJob({
			lenses: [lens1, lens2],
			states: new Map([
				[
					lens1,
					buildLensState({
						status: "done",
						modelName: "Claude Sonnet 4",
						provider: "anthropic",
						durationMs: 3000,
						findingsCount: 2,
					}),
				],
				[
					lens2,
					buildLensState({
						status: "done",
						modelName: "GPT-4o",
						provider: "openai",
						durationMs: 4000,
						findingsCount: 1,
					}),
				],
			]),
		});
		const lines = renderLines(job);
		// Line 0: heading, Line 1: KISS, Line 2: DRY
		expect(lines[1]).toContain("KISS");
		expect(lines[1]).toContain("anthropic/Claude Sonnet 4");
		expect(lines[2]).toContain("DRY");
		expect(lines[2]).toContain("openai/GPT-4o");
	});

	it("handles errored jobs with a red icon and missing synthesis", () => {
		const lens: ReviewLens = "simplicity";
		const state: LensState = buildLensState({
			status: "error",
			errorMessage: "boom",
			modelName: "Sonnet",
			provider: "anthropic",
		});
		const job: ReviewJob = {
			id: "j4",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "error",
			overallStatus: "error",
			startedAt: Date.now() - 5000,
			completedAt: Date.now(),
		};
		const lines = renderLines(job);
		expect(lines[0]).toContain("DRYKISS Review");
		expect(lines[0]).toContain("Review failed");
		// Per-lens line should show error status
		expect(lines[1]).toContain("✗");
		expect(lines[1]).toContain("boom");
	});

	it("renders the elapsed duration in the heading", () => {
		const lines = renderLines(buildCompletedJob());
		// heading line should contain an elapsed time like "5.0s"
		expect(lines[0]).toMatch(/\d+\.\ds/);
	});

	it("hides the score line when synthesis is missing (undefined healthScore)", () => {
		const job = buildCompletedJob({
			synthesisResult: {
				findings: [],
				summary: "ok",
				verdict: "Approve",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			} as any,
		});
		const lines = renderLines(job);
		expect(lines[0]).not.toContain("score");
	});

	it("hides the score line when synthesis has no scoreBreakdown property", () => {
		const job = buildCompletedJob({
			synthesisResult: {
				findings: [],
				summary: "ok",
				verdict: "Approve",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				healthScore: 0,
			} as any,
		});
		const lines = renderLines(job);
		expect(lines[0]).toContain("score 0/100");
	});

	it("color-bands the score in the completed summary", () => {
		const seenColors: Set<string> = new Set();
		const theme = {
			fg: (color: string, text: string) => {
				seenColors.add(color);
				return `[${color}:${text}]`;
			},
			bold: (text: string) => text,
		};

		function buildWithScore(score: number): ReviewJob {
			const lens: ReviewLens = "simplicity";
			return buildCompletedJob({
				synthesisResult: {
					findings: [],
					summary: "ok",
					verdict: "Approve",
					criticalCount: 0,
					highCount: 0,
					mediumCount: 0,
					lowCount: 0,
					nitCount: 0,
					healthScore: score,
					scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
				},
				states: new Map([[lens, buildLensState({ status: "done" })]]),
			});
		}

		function renderOne(job: ReviewJob): string[] {
			let captured: (() => string[]) | undefined;
			const widget = new ReviewProgressWidget();
			const uiCtx = {
				setWidget: (
					_key: string,
					fn: (tui: any, theme: any) => { render: () => string[] },
				) => {
					captured = () => fn({ terminal: { columns: 200 } }, theme).render();
				},
			};
			widget.attach(uiCtx);
			widget.setJobs([job]);
			const lines = captured?.() ?? [];
			widget.dispose();
			return lines;
		}

		let lines = renderOne(buildWithScore(92));
		expect(lines[0]).toContain("[success:score 92/100]");
		lines = renderOne(buildWithScore(65));
		expect(lines[0]).toContain("[warning:score 65/100]");
		lines = renderOne(buildWithScore(30));
		expect(lines[0]).toContain("[error:score 30/100]");
		lines = renderOne(buildWithScore(80));
		expect(lines[0]).toContain("[success:score 80/100]");
		lines = renderOne(buildWithScore(50));
		expect(lines[0]).toContain("[warning:score 50/100]");
	});

	it("prefers the final post-processed result over raw synthesis", () => {
		const lines = renderLines(
			buildCompletedJob({
				synthesisResult: {
					findings: [],
					summary: "raw",
					verdict: "Needs security review",
					criticalCount: 0,
					highCount: 7,
					mediumCount: 0,
					lowCount: 0,
					nitCount: 0,
					healthScore: 10,
					scoreBreakdown: { critical: 0, warning: 7, suggestion: 0 },
				},
				finalResult: {
					jobId: "j3",
					clean: true,
					status: "done",
					verdict: "Approve",
					target: { mode: "local", label: "local changes" },
					reportPath: "/tmp/drykiss-report.json",
					files: [],
					counts: {
						total: 0,
						critical: 0,
						high: 0,
						medium: 0,
						low: 0,
						nit: 0,
						suppressed: 1,
						previouslyRejected: 2,
						validatorFalsePositive: 3,
					},
					findings: [],
					summary: "final",
					errors: [],
					validationIssues: [],
					healthScore: 100,
					scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
				},
			}),
		);

		expect(lines[0]).toContain("Verdict: Approve");
		expect(lines[0]).toContain("local changes");
		expect(lines[0]).toContain("score 100/100");
		expect(lines[0]).not.toContain("Needs security review");
		expect(lines[2]).toContain("0 findings");
		expect(lines[2]).toContain("1 suppressed");
		expect(lines[2]).toContain("2 previously-rejected");
		expect(lines[2]).toContain("3 validator-refuted");
		expect(lines[3]).toContain("report:");
		expect(lines[3]).toContain("drykiss-report.json");
	});
});

describe("per-lens line — session log link", () => {
	const lens: ReviewLens = "simplicity";

	function buildCompletedJobWithState(state: LensState): ReviewJob {
		return {
			id: "j1",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "done",
			overallStatus: "done",
			startedAt: Date.now(),
			completedAt: Date.now(),
			synthesisResult: {
				findings: [],
				summary: "ok",
				verdict: "Approve",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			},
		};
	}

	it("appends an OSC 8 hyperlink for a done lens with logPath", () => {
		const job = buildCompletedJobWithState(
			buildLensState({
				status: "done",
				durationMs: 8400,
				findingsCount: 5,
				logPath: "/home/user/.pi/drykiss/sessions/j1-simplicity.jsonl",
			}),
		);
		const line = renderJobLine(job, 1);
		expect(line).toContain("\x1b]8;;file://");
		expect(line).toContain("j1-simplicity.jsonl");
	});

	it("appends the link for an errored lens with logPath", () => {
		const job = buildCompletedJobWithState(
			buildLensState({
				status: "error",
				errorMessage: "boom",
				logPath: "/home/user/.pi/drykiss/sessions/j1-simplicity.jsonl",
			}),
		);
		const line = renderJobLine(job, 1);
		expect(line).toContain("\x1b]8;;");
		expect(line).toContain("j1-simplicity.jsonl");
	});

	it("does NOT append a link for a done lens without logPath", () => {
		const job = buildCompletedJobWithState(
			buildLensState({ status: "done", durationMs: 1000, findingsCount: 0 }),
		);
		const line = renderJobLine(job, 1);
		expect(line).not.toContain("\x1b]8;;");
	});
});

describe("per-lens line — provider display", () => {
	const lens: ReviewLens = "simplicity";

	function buildCompletedJobWithState(state: LensState): ReviewJob {
		return {
			id: "j2",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "done",
			overallStatus: "done",
			startedAt: Date.now(),
			completedAt: Date.now(),
			synthesisResult: {
				findings: [],
				summary: "ok",
				verdict: "Approve",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			},
		};
	}

	it("renders provider/modelName together when provider is set", () => {
		const job = buildCompletedJobWithState(
			buildLensState({
				status: "done",
				durationMs: 1000,
				findingsCount: 0,
				modelName: "Claude Sonnet 4",
				provider: "anthropic",
			}),
		);
		const line = renderJobLine(job, 1);
		expect(line).toContain("@ anthropic/Claude Sonnet 4");
	});

	it("falls back to modelName alone when provider is missing", () => {
		const job = buildCompletedJobWithState(
			buildLensState({
				status: "done",
				durationMs: 1000,
				findingsCount: 0,
				modelName: "Claude Sonnet 4",
			}),
		);
		const line = renderJobLine(job, 1);
		expect(line).toContain("@ Claude Sonnet 4");
		expect(line).not.toContain("/Claude Sonnet 4");
	});

	it("treats whitespace-only provider as missing", () => {
		const job = buildCompletedJobWithState(
			buildLensState({
				status: "done",
				durationMs: 1000,
				findingsCount: 0,
				modelName: "GPT-4o",
				provider: "   ",
			}),
		);
		const line = renderJobLine(job, 1);
		expect(line).toContain("@ GPT-4o");
		expect(line).not.toContain("/GPT-4o");
	});
});

describe("formatFinding", () => {
	function buildFinding(overrides: Partial<Finding> = {}): Finding {
		return {
			file: "src/user.ts",
			line: 42,
			severity: "high",
			category: "Divergent Change",
			summary: "Two call sites diverge",
			detail: "update_profile and update_admin both fork on the same field.",
			suggestion: "Extract a shared helper.",
			consequence: "Future changes will be missed in one branch.",
			source: "UserService.update_profile",
			fixability: "guided",
			riskCode: "R1",
			lens: "simplicity",
			...overrides,
		};
	}

	it("renders the heading with severity icon, lens tag, category, source, and location", () => {
		const out = formatFinding(buildFinding());
		const firstLine = out.split("\n")[0];
		expect(firstLine).toBe(
			"🟠 [KISS] Divergent Change — UserService.update_profile (src/user.ts:42)",
		);
	});

	it("includes the Symptom line with detail", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain(
			"Symptom: update_profile and update_admin both fork on the same field.",
		);
	});

	it("includes the Consequence line when consequence is set", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain(
			"→ Consequence: Future changes will be missed in one branch.",
		);
	});

	it("includes the Fix line with fixability label and suggestion", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain(
			"→ Fix: guided (~10 lines) — Extract a shared helper.",
		);
	});

	it("includes the riskCode annotation when set", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain("[riskCode: R1]");
	});

	it("omits the Consequence line for legacy findings without one", () => {
		const out = formatFinding(
			buildFinding({ consequence: undefined, source: undefined }),
		);
		expect(out).not.toContain("Consequence");
	});

	it("omits the Fix line when suggestion is empty", () => {
		const out = formatFinding(buildFinding({ suggestion: "" }));
		expect(out).not.toContain("→ Fix:");
	});

	it("falls back to plain '→ Fix: <suggestion>' when fixability is missing", () => {
		const out = formatFinding(buildFinding({ fixability: undefined }));
		expect(out).toContain("→ Fix: Extract a shared helper.");
		expect(out).not.toContain("(~10 lines)");
	});

	it("uses different severity icons", () => {
		expect(
			formatFinding(buildFinding({ severity: "critical" })).split("\n")[0],
		).toMatch(/^🔴/);
		expect(
			formatFinding(buildFinding({ severity: "medium" })).split("\n")[0],
		).toMatch(/^🟡/);
		expect(
			formatFinding(buildFinding({ severity: "low" })).split("\n")[0],
		).toMatch(/^🔵/);
		expect(
			formatFinding(buildFinding({ severity: "nit" })).split("\n")[0],
		).toMatch(/^⚪/);
	});

	it("omits line number from location when line is undefined", () => {
		const out = formatFinding(buildFinding({ line: undefined }));
		expect(out.split("\n")[0]).toContain("(src/user.ts)");
		expect(out.split("\n")[0]).not.toContain("src/user.ts:42");
	});

	it("uses the lens display name from LENS_DISPLAY_NAMES", () => {
		const out = formatFinding(buildFinding({ lens: "deduplication" }));
		expect(out).toContain("[DRY]");
		expect(out).not.toContain("[deduplication]");
	});

	it("falls back to the raw lens name when unknown", () => {
		const out = formatFinding(buildFinding({ lens: "simplicity" }));
		expect(out).toContain("[KISS]");
	});
});

describe("ReviewProgressWidget — lifecycle", () => {
	function makeCompletedJob(): ReviewJob {
		const lens: ReviewLens = "simplicity";
		return {
			id: "lifecycle",
			files: [],
			lenses: [lens],
			states: new Map([
				[
					lens,
					buildLensState({
						status: "done",
						modelName: "Sonnet",
						provider: "anthropic",
						durationMs: 100,
						findingsCount: 0,
					}),
				],
			]),
			synthesisStatus: "done",
			overallStatus: "done",
			startedAt: Date.now() - 1000,
			completedAt: Date.now(),
			synthesisResult: {
				findings: [],
				summary: "ok",
				verdict: "Approve",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				healthScore: 90,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			},
		};
	}

	function makeRunningJob(): ReviewJob {
		const lens: ReviewLens = "simplicity";
		return {
			id: "running",
			files: [],
			lenses: [lens],
			states: new Map([
				[
					lens,
					buildLensState({
						status: "running",
						modelName: "Sonnet",
						provider: "anthropic",
						durationMs: 0,
						findingsCount: 0,
						startedAt: Date.now() - 500,
					}),
				],
			]),
			synthesisStatus: "idle",
			overallStatus: "running",
			startedAt: Date.now() - 500,
		};
	}

	function attachAndCapture(widget: ReviewProgressWidget): {
		captured?: () => string[];
		setJobs: (jobs: ReviewJob[]) => void;
	} {
		let captured: (() => string[]) | undefined;
		const theme = {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
		};
		const uiCtx = {
			setWidget: (
				_key: string,
				fn: (tui: any, theme: any) => { render: () => string[] },
			) => {
				captured = () => fn({ terminal: { columns: 200 } }, theme).render();
			},
		};
		widget.attach(uiCtx);
		return {
			get captured() {
				return captured;
			},
			setJobs: (jobs: ReviewJob[]) => widget.setJobs(jobs),
		};
	}

	it("keeps the widget alive when only completed jobs remain", () => {
		const widget = new ReviewProgressWidget();
		const ctx = attachAndCapture(widget);
		ctx.setJobs([makeCompletedJob()]);
		expect(ctx.captured).toBeDefined();
		const lines = ctx.captured!();
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toContain("DRYKISS Review");
		widget.dispose();
	});

	it("stops the 80ms render timer when only completed jobs remain", () => {
		const widget = new ReviewProgressWidget();
		const ctx = attachAndCapture(widget);
		ctx.setJobs([makeRunningJob()]);
		expect(widget["timer"]).toBeDefined();
		ctx.setJobs([makeCompletedJob()]);
		expect(widget["timer"]).toBeUndefined();
		widget.dispose();
	});

	it("restarts the render timer when a new live job lands", () => {
		const widget = new ReviewProgressWidget();
		const ctx = attachAndCapture(widget);
		ctx.setJobs([makeCompletedJob()]);
		expect(widget["timer"]).toBeUndefined();
		ctx.setJobs([makeRunningJob()]);
		expect(widget["timer"]).toBeDefined();
		widget.dispose();
	});

	it("disposes the widget when the jobs list is empty", () => {
		const widget = new ReviewProgressWidget();
		const ctx = attachAndCapture(widget);
		ctx.setJobs([makeCompletedJob()]);
		expect(ctx.captured).toBeDefined();
		ctx.setJobs([]);
		expect(widget["widgetRegistered"]).toBe(false);
	});
});

describe("collectModelPairs", () => {
	it("returns an empty array for an empty iterable", () => {
		expect(collectModelPairs([])).toEqual([]);
	});

	it("skips entries that are undefined", () => {
		expect(collectModelPairs([["a", undefined]])).toEqual([]);
	});

	it("returns provider/modelName pairs", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[["simplicity", { provider: "anthropic", modelName: "Claude Sonnet 4" }]];
		expect(collectModelPairs(entries)).toEqual(["anthropic/Claude Sonnet 4"]);
	});

	it("returns modelName alone when provider is missing", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[["simplicity", { modelName: "Claude Sonnet 4" }]];
		expect(collectModelPairs(entries)).toEqual(["Claude Sonnet 4"]);
	});

	it("returns provider alone when modelName is missing", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[["simplicity", { provider: "anthropic" }]];
		expect(collectModelPairs(entries)).toEqual(["anthropic"]);
	});

	it("skips entries where both provider and modelName are missing", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[
				["a", {}],
				["b", { provider: "openai", modelName: "GPT-4o" }],
			];
		expect(collectModelPairs(entries)).toEqual(["openai/GPT-4o"]);
	});

	it("skips whitespace-only values", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[
				["a", { provider: "   ", modelName: "   " }],
				["b", { provider: "anthropic", modelName: "Sonnet" }],
			];
		expect(collectModelPairs(entries)).toEqual(["anthropic/Sonnet"]);
	});

	it("trims surrounding whitespace from values", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[["a", { provider: "  anthropic  ", modelName: "\tSonnet\n" }]];
		expect(collectModelPairs(entries)).toEqual(["anthropic/Sonnet"]);
	});

	it("deduplicates identical pairs", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[
				["a", { provider: "anthropic", modelName: "Sonnet" }],
				["b", { provider: "anthropic", modelName: "Sonnet" }],
				["c", { provider: "openai", modelName: "GPT-4o" }],
			];
		expect(collectModelPairs(entries)).toEqual([
			"anthropic/Sonnet",
			"openai/GPT-4o",
		]);
	});

	it("returns results sorted alphabetically for deterministic output", () => {
		const entries: Array<[string, { provider?: string; modelName?: string }]> =
			[
				["a", { provider: "openai", modelName: "GPT-4o" }],
				["b", { provider: "anthropic", modelName: "Sonnet" }],
				["c", { provider: "google", modelName: "Gemini" }],
			];
		expect(collectModelPairs(entries)).toEqual([
			"anthropic/Sonnet",
			"google/Gemini",
			"openai/GPT-4o",
		]);
	});

	it("coerces non-string provider/modelName safely", () => {
		const entries: Array<
			[string, { provider?: unknown; modelName?: unknown }]
		> = [
			["a", { provider: null, modelName: undefined }],
			["b", { provider: 42, modelName: { name: "x" } }],
			["c", { provider: "anthropic", modelName: "Sonnet" }],
		];
		expect(collectModelPairs(entries)).toEqual(["anthropic/Sonnet"]);
	});
});

describe("pickVerdict", () => {
	it("returns the synthesis verdict when it is a non-empty string", () => {
		expect(pickVerdict("Approve", false)).toBe("Approve");
		expect(pickVerdict("Request changes", false)).toBe("Request changes");
		expect(pickVerdict("Needs security review", false)).toBe(
			"Needs security review",
		);
	});

	it("returns 'Review failed' when the job errored and verdict is missing", () => {
		expect(pickVerdict(undefined, true)).toBe("Review failed");
		expect(pickVerdict(null, true)).toBe("Review failed");
		expect(pickVerdict("", true)).toBe("Review failed");
	});

	it("returns 'Request changes' when the job is fine but verdict is missing", () => {
		expect(pickVerdict(undefined, false)).toBe("Request changes");
		expect(pickVerdict(null, false)).toBe("Request changes");
		expect(pickVerdict("", false)).toBe("Request changes");
	});

	it("falls through on empty string verdict", () => {
		expect(pickVerdict("", false).length).toBeGreaterThan(0);
	});

	it("returns the verdict even when the job errored", () => {
		expect(pickVerdict("Approve", true)).toBe("Approve");
	});

	it("handles non-string verdict types safely", () => {
		expect(pickVerdict(42, false)).toBe("Request changes");
		expect(pickVerdict({ verdict: "Approve" }, false)).toBe("Request changes");
		expect(pickVerdict(true, false)).toBe("Request changes");
	});
});
