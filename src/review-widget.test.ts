import { describe, expect, it } from "vitest";
import {
	ReviewProgressWidget,
	collectModelPairs,
	formatReviewWorkingMessage,
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
			fn: ((tui: any, theme: any) => { render: () => string[] }) | undefined,
		) => {
			captured = fn
				? () => fn({ terminal: { columns: 200 } }, theme).render()
				: () => [];
		},
	};
	widget.attach(uiCtx);
	widget.setJobs([job]);
	const lines = captured?.() ?? [];
	widget.dispose();
	return lines;
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
	const job = buildRunningJob(elapsedMs);
	const heading = formatReviewWorkingMessage(job);
	// Extract the trailing elapsed-time segment:
	// "Simplicity running · 0 file(s) · [░░░░░░░░░░] 0/1 complete · 12.3s"
	const match = heading.match(/·\s*([\d.]+s|\d+m \d+s|\dh \d+m)$/);
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
});

describe("ReviewProgressWidget — completion lifecycle", () => {
	it("renders no persistent summary after completion", () => {
		const job = buildRunningJob(0);
		job.overallStatus = "done";
		expect(renderLines(job)).toEqual([]);
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
				fn: ((tui: any, theme: any) => { render: () => string[] }) | undefined,
			) => {
				captured = fn
					? () => fn({ terminal: { columns: 200 } }, theme).render()
					: () => [];
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

	it("disposes the widget when only completed jobs remain", () => {
		const widget = new ReviewProgressWidget();
		const ctx = attachAndCapture(widget);
		ctx.setJobs([makeCompletedJob()]);
		expect(ctx.captured).toBeDefined();
		const lines = ctx.captured!();
		expect(lines).toEqual([]);
		expect(widget["widgetRegistered"]).toBe(false);
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
