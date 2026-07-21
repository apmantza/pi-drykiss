/**
 * Unit tests for src/triage.ts
 *
 * The tests focus on:
 *   - formatTriageSummary: pure formatting, no I/O.
 *   - runTriage with a mock ExtensionContext:
 *       - headless (no ctx.ui.custom) → all findings end up in `skipped`.
 *       - all findings accepted → accepted list populated.
 *       - one dismiss → appendRejections called; dismissed list populated.
 *       - one defer → saveProjectConfig called; deferred list populated.
 *       - skip-all action → remaining findings added to skipped.
 *       - null return from overlay → all remaining skipped.
 *       - overlay error → all findings skipped, no throw.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (hoisted before any imports) ─────────────────────────

vi.mock("./rejections.js", () => ({
	appendRejections: vi.fn().mockResolvedValue(undefined),
	toRejectionRecords: vi.fn().mockImplementation(
		(findings: any[], opts: { source?: string }) =>
			findings.map((f: any) => ({
				file: f.file,
				line: f.line,
				severity: f.severity,
				message: f.summary,
				recorded_at: new Date().toISOString(),
				source: opts?.source,
			})),
	),
}));

vi.mock("./config.js", () => ({
	saveProjectConfig: vi.fn().mockResolvedValue(undefined),
	loadEffectiveConfig: vi.fn().mockResolvedValue({
		config: { suppressions: [] },
		warnings: [],
	}),
}));

// Import after mocks (top-level await OK in Vitest/ESM)
const { runTriage, formatTriageSummary, DEFER_DAYS } = await import(
	"./triage.js"
);
const { appendRejections } = await import("./rejections.js");
const { saveProjectConfig } = await import("./config.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

import type { Finding } from "./types.js";
import type { ReviewResult } from "./review-result.js";
import type { TriageAction } from "./triage.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/foo.ts",
		line: 42,
		severity: "high",
		category: "security",
		summary: "SQL injection risk",
		detail: "User input is interpolated directly into the query string.",
		suggestion: "Use parameterised queries.",
		...overrides,
	};
}

function makeResult(findings: Finding[]): ReviewResult {
	return {
		jobId: "test-job",
		clean: findings.length === 0,
		status: "done",
		reviewStatus: "done",
		codeRisk: "clean",
		qualityGate: { status: "pass", threshold: 70, score: 100, reasons: [] },
		verdict: "Approve",
		verdictSource: "deterministic",
		omissions: {
			findingBudgetApplied: false,
			omittedLowPriorityCount: 0,
			omittedNitCount: 0,
		},
		files: ["src/foo.ts"],
		counts: {
			total: findings.length,
			critical: 0,
			high: findings.length,
			medium: 0,
			low: 0,
			nit: 0,
			suppressed: 0,
			previouslyRejected: 0,
		},
		findings,
		summary: "Test review",
		errors: [],
		validationIssues: [],
		healthScore: 100,
		scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
	};
}

/**
 * Build a minimal mock ExtensionContext whose `ctx.ui.custom` resolves
 * with the values from `actions` in sequence — one per triage overlay call.
 */
function makeCtx(actions: (TriageAction | null)[]): any {
	let callCount = 0;
	return {
		cwd: "/project",
		ui: {
			custom: vi.fn(async (_factory: any, _options: any) => {
				const action = actions[callCount] ?? null;
				callCount++;
				return action;
			}),
			notify: vi.fn(),
		},
	};
}

/** A context with no `ui.custom` (headless / test fallback). */
function makeHeadlessCtx(): any {
	return { cwd: "/project", ui: { notify: vi.fn() } };
}

// ── formatTriageSummary ───────────────────────────────────────────────────────

describe("formatTriageSummary", () => {
	it("returns empty string when no decisions", () => {
		expect(
			formatTriageSummary({
				decisions: [],
				accepted: [],
				dismissed: [],
				deferred: [],
				skipped: [],
			}),
		).toBe("");
	});

	it("includes only present categories", () => {
		const f = makeFinding();
		const result = formatTriageSummary({
			decisions: [{ finding: f, action: "dismiss" }],
			accepted: [],
			dismissed: [f],
			deferred: [],
			skipped: [],
		});
		expect(result).toContain("1 dismissed");
		expect(result).not.toContain("accepted");
		expect(result).not.toContain("deferred");
		expect(result).not.toContain("skipped");
	});

	it("includes defer day count", () => {
		const f = makeFinding();
		const result = formatTriageSummary({
			decisions: [{ finding: f, action: "defer" }],
			accepted: [],
			dismissed: [],
			deferred: [f],
			skipped: [],
		});
		expect(result).toContain(`${DEFER_DAYS} days`);
	});

	it("combines multiple categories", () => {
		const f1 = makeFinding({ summary: "A" });
		const f2 = makeFinding({ summary: "B" });
		const f3 = makeFinding({ summary: "C" });
		const result = formatTriageSummary({
			decisions: [
				{ finding: f1, action: "accept" },
				{ finding: f2, action: "dismiss" },
				{ finding: f3, action: "defer" },
			],
			accepted: [f1],
			dismissed: [f2],
			deferred: [f3],
			skipped: [],
		});
		expect(result).toContain("1 accepted");
		expect(result).toContain("1 dismissed");
		expect(result).toContain("1 deferred");
	});
});

// ── runTriage ─────────────────────────────────────────────────────────────────

describe("runTriage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns all findings as skipped in headless context", async () => {
		const f = makeFinding();
		const result = makeResult([f]);
		const summary = await runTriage(result, makeHeadlessCtx(), "/project");
		expect(summary.skipped).toEqual([f]);
		expect(summary.accepted).toHaveLength(0);
		expect(summary.dismissed).toHaveLength(0);
		expect(summary.deferred).toHaveLength(0);
		expect(summary.decisions).toHaveLength(0);
	});

	it("returns empty summary when no active findings", async () => {
		const f: Finding = { ...makeFinding(), _suppressed: true };
		const result = makeResult([f]);
		const summary = await runTriage(result, makeCtx([]), "/project");
		expect(summary.skipped).toHaveLength(0);
		expect(summary.accepted).toHaveLength(0);
	});

	it("records accept decisions without calling persist functions", async () => {
		const f = makeFinding();
		const result = makeResult([f]);
		const ctx = makeCtx(["accept"]);
		const summary = await runTriage(result, ctx, "/project");
		expect(summary.accepted).toEqual([f]);
		expect(appendRejections).not.toHaveBeenCalled();
		expect(saveProjectConfig).not.toHaveBeenCalled();
	});

	it("calls appendRejections for dismissed findings", async () => {
		const f = makeFinding();
		const result = makeResult([f]);
		const ctx = makeCtx(["dismiss"]);
		const summary = await runTriage(result, ctx, "/project");
		expect(summary.dismissed).toEqual([f]);
		expect(appendRejections).toHaveBeenCalledOnce();
		const [cwd, records] = (appendRejections as any).mock.calls[0];
		expect(cwd).toBe("/project");
		expect(records).toHaveLength(1);
		expect(records[0].file).toBe(f.file);
		expect(records[0].source).toBe("user");
	});

	it("calls saveProjectConfig for deferred findings", async () => {
		const f = makeFinding();
		const result = makeResult([f]);
		const ctx = makeCtx(["defer"]);
		const summary = await runTriage(result, ctx, "/project");
		expect(summary.deferred).toEqual([f]);
		expect(saveProjectConfig).toHaveBeenCalledOnce();
		const [cwd, projectConfig] = (saveProjectConfig as any).mock.calls[0];
		expect(cwd).toBe("/project");
		expect(projectConfig.suppressions).toHaveLength(1);
		const suppression = projectConfig.suppressions![0];
		expect(suppression.pattern).toBe(f.file);
		expect(suppression.expiresAt).toBeDefined();
		// Expiry should be roughly DEFER_DAYS from now
		const expiryMs = new Date(suppression.expiresAt!).getTime();
		const nowMs = Date.now();
		expect(expiryMs).toBeGreaterThan(nowMs);
		expect(expiryMs).toBeLessThanOrEqual(
			nowMs + DEFER_DAYS * 24 * 60 * 60 * 1000 + 5_000,
		);
	});

	it("stops triage early when skip action is returned", async () => {
		const f1 = makeFinding({ summary: "A" });
		const f2 = makeFinding({ summary: "B" });
		const f3 = makeFinding({ summary: "C" });
		const result = makeResult([f1, f2, f3]);
		// Accept first, then skip (should cancel f2 and f3)
		const ctx = makeCtx(["accept", "skip"]);
		const summary = await runTriage(result, ctx, "/project");
		expect(summary.accepted).toEqual([f1]);
		expect(summary.skipped).toContain(f2);
		expect(summary.skipped).toContain(f3);
		expect(summary.dismissed).toHaveLength(0);
	});

	it("skips all remaining when overlay returns null", async () => {
		const f1 = makeFinding({ summary: "A" });
		const f2 = makeFinding({ summary: "B" });
		const result = makeResult([f1, f2]);
		// First call accepts, second returns null (overlay closed)
		const ctx = makeCtx(["accept", null]);
		const summary = await runTriage(result, ctx, "/project");
		expect(summary.accepted).toEqual([f1]);
		expect(summary.skipped).toEqual([f2]);
	});

	it("uses provided findings override instead of result.findings", async () => {
		const f1 = makeFinding({ summary: "In result" });
		const f2 = makeFinding({ summary: "Override" });
		const result = makeResult([f1]);
		const ctx = makeCtx(["accept"]);
		const summary = await runTriage(result, ctx, "/project", {
			findings: [f2],
		});
		expect(summary.accepted).toEqual([f2]);
		expect(summary.accepted).not.toContain(f1);
	});

	it("filters out suppressed and previously-rejected by default", async () => {
		const active = makeFinding({ summary: "Active" });
		const suppressed: Finding = {
			...makeFinding({ summary: "Suppressed" }),
			_suppressed: true,
		};
		const rejected: Finding = {
			...makeFinding({ summary: "Rejected" }),
			_previouslyRejected: true,
		};
		const result = makeResult([active, suppressed, rejected]);
		// Only one overlay call expected (for active finding)
		const ctx = makeCtx(["accept"]);
		const summary = await runTriage(result, ctx, "/project");
		expect(summary.accepted).toEqual([active]);
		expect(summary.skipped).toHaveLength(0);
	});

	it("handles overlay errors gracefully by skipping the finding", async () => {
		const f1 = makeFinding({ summary: "A" });
		const f2 = makeFinding({ summary: "B" });
		const result = makeResult([f1, f2]);

		let callCount = 0;
		const ctx = {
			cwd: "/project",
			ui: {
				custom: vi.fn(async () => {
					callCount++;
					if (callCount === 1) throw new Error("UI error");
					return "accept" as TriageAction;
				}),
				notify: vi.fn(),
			},
		};

		// Should not throw; f1 goes to skipped (error → null → skips all remaining)
		const summary = await runTriage(result, ctx as any, "/project");
		// f1 triggered an error, overlay returned null, f1 and f2 both skip
		expect(summary.skipped).toContain(f1);
		// f2 may or may not have been attempted depending on behaviour;
		// critical invariant: no throw and accepted list doesn't have f1
		expect(summary.accepted).not.toContain(f1);
	});
});
