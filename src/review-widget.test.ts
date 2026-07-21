import { describe, expect, it } from "vitest";
import {
	ReviewProgressWidget,
	collectModelPairs,
	formatReviewWorkingMessage,
	pickVerdict,
	formatFinding,
	groupFindingsByRiskCode,
	formatFindingsGrouped,
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

	it("uses a safe fallback for non-finite elapsed time", () => {
		const job = buildRunningJob(0);
		job.startedAt = Number.POSITIVE_INFINITY;
		expect(formatReviewWorkingMessage(job)).toContain("0.0s");
	});

	it("renders live aggregate progress in the persistent widget", () => {
		const lines = renderLines(buildRunningJob(12_300));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("KISS running");
		expect(lines[0]).toContain("12.3s");
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

	it("strips terminal control sequences from file and category", () => {
		const out = formatFinding(
			buildFinding({
				file: "src/\u001b[31msecret.ts",
				category: "Bad\u001b]8;;https://example.test\u0007Category",
			}),
		);
		expect(out).not.toContain("\u001b");
		expect(out).toContain("src/secret.ts");
		expect(out).toContain("BadCategory");
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

	it("absorbs UI registration failures", () => {
		let calls = 0;
		const widget = new ReviewProgressWidget();
		const uiCtx = {
			setWidget: () => {
				calls += 1;
				if (calls > 1) throw new Error("registration failed");
			},
		};
		widget.attach(uiCtx);
		expect(() => widget.setJobs([buildRunningJob(0)])).not.toThrow();
	});

	it("returns an empty render when the widget formatter throws", () => {
		let render: (() => string[]) | undefined;
		const widget = new ReviewProgressWidget();
		const uiCtx = {
			setWidget: (
				_key: string,
				factory?: (tui: unknown, theme: unknown) => { render: () => string[] },
			) => {
				if (factory) render = factory({}, {}).render;
			},
		};
		widget.attach(uiCtx);
		widget.setJobs([
			{
				...buildRunningJob(0),
				lenses: undefined as unknown as ReviewJob["lenses"],
			},
		]);
		expect(render?.()).toEqual([]);
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

	it("trims whitespace-only and padded verdicts", () => {
		expect(pickVerdict("   ", false)).toBe("Request changes");
		expect(pickVerdict("  Approve  ", false)).toBe("Approve");
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

describe("groupFindingsByRiskCode", () => {
	function makeFinding(overrides: Partial<Finding> = {}): Finding {
		return {
			file: "src/a.ts",
			severity: "high",
			category: "Cat",
			summary: "sum",
			detail: "det",
			suggestion: "sug",
			...overrides,
		};
	}

	it("returns an empty array for no findings", () => {
		expect(groupFindingsByRiskCode([])).toEqual([]);
	});

	it("places findings without riskCode into an Other bucket", () => {
		const f = makeFinding();
		const groups = groupFindingsByRiskCode([f]);
		expect(groups).toHaveLength(1);
		expect(groups[0].riskCode).toBeNull();
		expect(groups[0].name).toBe("Other");
		expect(groups[0].findings).toEqual([f]);
	});

	it("omits the Other bucket when all findings have a riskCode", () => {
		const f = makeFinding({ riskCode: "K1" });
		const groups = groupFindingsByRiskCode([f]);
		expect(groups.every((g) => g.riskCode !== null)).toBe(true);
	});

	it("resolves known risk codes to their catalogue name", () => {
		const f = makeFinding({ riskCode: "K1" });
		const groups = groupFindingsByRiskCode([f]);
		expect(groups[0].riskCode).toBe("K1");
		expect(groups[0].name).toBe("KISS violation");
	});

	it("falls back to the raw code when the code is not in the catalogue", () => {
		const f = makeFinding({ riskCode: "ZZ99" });
		const groups = groupFindingsByRiskCode([f]);
		expect(groups[0].riskCode).toBe("ZZ99");
		expect(groups[0].name).toBe("ZZ99");
	});

	it("groups multiple findings under the same code", () => {
		const f1 = makeFinding({ riskCode: "R1" });
		const f2 = makeFinding({ riskCode: "R1", file: "src/b.ts" });
		const groups = groupFindingsByRiskCode([f1, f2]);
		expect(groups).toHaveLength(1);
		expect(groups[0].findings).toHaveLength(2);
	});

	it("preserves first-seen order for risk codes", () => {
		const fK1 = makeFinding({ riskCode: "K1" });
		const fR1 = makeFinding({ riskCode: "R1" });
		const fD1 = makeFinding({ riskCode: "D1" });
		const groups = groupFindingsByRiskCode([fK1, fR1, fD1]);
		expect(groups.map((g) => g.riskCode)).toEqual(["K1", "R1", "D1"]);
	});

	it("puts the Other bucket last when mixed findings are present", () => {
		const fCoded = makeFinding({ riskCode: "S1" });
		const fNone = makeFinding();
		const groups = groupFindingsByRiskCode([fCoded, fNone]);
		expect(groups[groups.length - 1].riskCode).toBeNull();
	});
});

describe("formatFindingsGrouped", () => {
	function makeFinding(overrides: Partial<Finding> = {}): Finding {
		return {
			file: "src/a.ts",
			severity: "high",
			category: "Cat",
			summary: "sum",
			detail: "det",
			suggestion: "sug",
			lens: "simplicity",
			...overrides,
		};
	}

	it("returns an empty string for no findings", () => {
		expect(formatFindingsGrouped([])).toBe("");
	});

	it("renders a severity header for each non-empty bucket", () => {
		const f = makeFinding({ severity: "critical" });
		const out = formatFindingsGrouped([f]);
		expect(out).toContain("── Critical (1) ──");
	});

	it("omits severity buckets that have no findings", () => {
		const f = makeFinding({ severity: "medium" });
		const out = formatFindingsGrouped([f]);
		expect(out).not.toContain("Critical");
		expect(out).not.toContain("High");
		expect(out).toContain("Medium");
	});

	it("renders severity groups in canonical order (critical first)", () => {
		const fLow = makeFinding({ severity: "low" });
		const fCrit = makeFinding({ severity: "critical" });
		const out = formatFindingsGrouped([fLow, fCrit]);
		expect(out.indexOf("Critical")).toBeLessThan(out.indexOf("Low"));
	});

	it("auto-enables risk-code sub-groups when any finding has a riskCode", () => {
		const f = makeFinding({ riskCode: "K1" });
		const out = formatFindingsGrouped([f]);
		expect(out).toContain("[K1] KISS violation");
	});

	it("does not render risk-code sub-groups when no finding has a riskCode", () => {
		const f = makeFinding();
		const out = formatFindingsGrouped([f]);
		// severity header present, but no sub-group badge line (e.g. "[K1] ..." or "Other (N)")
		expect(out).toContain("── High (1) ──");
		expect(out).not.toMatch(/^\s+\[/m); // no indented badge line
		expect(out).not.toContain("Other (");
	});

	it("shows the finding count in the sub-group header", () => {
		const f1 = makeFinding({ riskCode: "R1" });
		const f2 = makeFinding({ riskCode: "R1", file: "src/b.ts" });
		const out = formatFindingsGrouped([f1, f2]);
		expect(out).toContain("[R1] Divergent change (2)");
	});

	it("renders an Other sub-group for findings without riskCode", () => {
		const fCoded = makeFinding({ riskCode: "K1" });
		const fNone = makeFinding({ riskCode: undefined });
		const out = formatFindingsGrouped([fCoded, fNone]);
		expect(out).toContain("Other (1)");
	});

	it("force-disables risk-code sub-groups when groupByRiskCode is false", () => {
		const f = makeFinding({ riskCode: "K1" });
		const out = formatFindingsGrouped([f], undefined, {
			groupByRiskCode: false,
		});
		expect(out).not.toContain("[K1]");
	});

	it("force-enables risk-code sub-groups when groupByRiskCode is true even without riskCodes", () => {
		const f = makeFinding({ riskCode: undefined });
		const out = formatFindingsGrouped([f], undefined, {
			groupByRiskCode: true,
		});
		// With no risk codes and forced grouping, falls into "Other" bucket
		expect(out).toContain("Other (1)");
	});

	it("indents finding lines under the sub-group header", () => {
		const f = makeFinding({ riskCode: "K1" });
		const out = formatFindingsGrouped([f]);
		// Each finding line should be indented by 2 spaces
		const findingLines = out
			.split("\n")
			.filter((line) => line.includes("🟠"));
		expect(findingLines.length).toBeGreaterThan(0);
		for (const line of findingLines) {
			expect(line.startsWith("  ")).toBe(true);
		}
	});

	it("uses the provided theme for bold and fg colouring", () => {
		const log: string[] = [];
		const theme = {
			fg: (color: string, text: string) => {
				log.push(`fg:${color}`);
				return text;
			},
			bold: (text: string) => {
				log.push("bold");
				return text;
			},
			dim: (_text: string) => _text,
		};
		const f = makeFinding({ riskCode: "D1" });
		formatFindingsGrouped([f], theme);
		expect(log).toContain("bold"); // severity header
		expect(log).toContain("fg:accent"); // sub-group badge
	});
});
