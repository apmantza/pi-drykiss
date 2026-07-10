import { describe, expect, it } from "vitest";
import {
	formatCompactViolation,
	formatReviewResultCompact,
} from "./compact-format.js";
import type { Finding } from "./types.js";
import type { ReviewResult } from "./review-result.js";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/a.ts",
		line: 10,
		severity: "medium",
		category: "DRY",
		summary: "Duplicated parsing logic across two modules",
		detail: "Both modules parse the same config format",
		suggestion: "Extract a shared parser",
		...overrides,
	};
}

function reviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
	return {
		jobId: "job-1",
		clean: false,
		status: "done",
		reviewStatus: "done",
		codeRisk: "comments",
		qualityGate: { status: "pass", threshold: 70, score: 95, reasons: [] },
		verdict: "Request changes",
		verdictSource: "deterministic",
		files: ["src/a.ts"],
		counts: {
			total: 1,
			critical: 0,
			high: 0,
			medium: 1,
			low: 0,
			nit: 0,
			suppressed: 0,
			previouslyRejected: 0,
		},
		findings: [finding()],
		summary: "Found one issue.",
		errors: [],
		validationIssues: [],
		healthScore: 95,
		scoreBreakdown: { critical: 0, warning: 1, suggestion: 0 },
		...overrides,
	};
}

describe("formatCompactViolation", () => {
	it("produces a kiss-style single-line format", () => {
		const line = formatCompactViolation(finding());
		expect(line).toMatch(
			/^DRYKISS:med :src\/a\.ts:10:.*:review \u2014 .*; fix: .*$/,
		);
	});

	it("includes the severity code in a fixed-width column", () => {
		const line = formatCompactViolation(finding({ severity: "critical" }));
		expect(line).toContain("DRYKISS:crit:");
	});

	it("includes the line number when present", () => {
		const line = formatCompactViolation(finding({ line: 42 }));
		expect(line).toContain(":42:");
	});

	it("omits the line number when missing", () => {
		const line = formatCompactViolation(finding({ line: undefined }));
		// With a missing line, we emit "-" as a placeholder so the
		// columns stay parseable: `DRYKISS:<sev>:<file>:-:<source>:<lens>`.
		expect(line).toMatch(/DRYKISS:[^:]+:src\/a\.ts:-:[^:]*:review/);
	});

	it("uses the lens name in the lens column", () => {
		const line = formatCompactViolation(finding({ lens: "security" }));
		expect(line).toContain(":security \u2014 ");
	});

	it("falls back to 'review' when lens is missing or 'all'", () => {
		expect(formatCompactViolation(finding({ lens: undefined }))).toContain(
			":review \u2014 ",
		);
		expect(formatCompactViolation(finding({ lens: "all" }))).toContain(
			":review \u2014 ",
		);
	});

	it("uses source as the symbol when present", () => {
		const line = formatCompactViolation(finding({ source: "processRequest" }));
		expect(line).toContain(":processRequest:");
	});

	it("collapses whitespace in the diagnosis", () => {
		const line = formatCompactViolation(
			finding({ summary: "Multi\n\n   line   summary\nwith gaps" }),
		);
		// The diagnosis segment after the em-dash should be a single
		// whitespace-collapsed line.
		const diagnosis = line.split(" \u2014 ")[1]?.split("; fix:")[0] ?? "";
		expect(diagnosis).not.toContain("\n");
		expect(diagnosis).not.toContain("  ");
	});

	it("truncates long diagnoses with an ellipsis on a word boundary", () => {
		const long = "word ".repeat(100);
		const line = formatCompactViolation(finding({ summary: long }));
		// The diagnosis is the middle segment; the ellipsis appears
		// right before "; fix:".
		expect(line).toMatch(/…; fix:/);
		// Should be well under the untruncated length.
		expect(line.length).toBeLessThan(long.length);
	});

	it("uses suggestion as the fix segment", () => {
		const line = formatCompactViolation(
			finding({ suggestion: "Replace with stdlib parse_url" }),
		);
		expect(line).toContain("fix: Replace with stdlib parse_url");
	});

	it("falls back to 'see diagnosis' when suggestion is empty and detail is empty", () => {
		const line = formatCompactViolation(
			finding({ suggestion: "", detail: "" }),
		);
		expect(line).toContain("fix: see diagnosis");
	});

	it("normalizes Windows backslashes in file paths", () => {
		const line = formatCompactViolation(finding({ file: "src\\a.ts" }));
		expect(line).toContain("src/a.ts");
		expect(line).not.toContain("src\\a.ts");
	});
});

describe("formatReviewResultCompact", () => {
	it("produces a header line with verdict and counts", () => {
		const text = formatReviewResultCompact(reviewResult());
		expect(text).toMatch(/^DRYKISS review complete /m);
		expect(text).toContain("verdict: Request changes");
		expect(text).toContain(
			"findings: 1 (0 critical, 0 high, 1 medium, 0 low, 0 nit)",
		);
		expect(text).toContain("health score: 95/100");
	});

	it("renders the violations section with one line per finding", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				findings: [
					finding({ severity: "high", summary: "First issue" }),
					finding({ severity: "critical", summary: "Second issue" }),
				],
			}),
		);
		expect(text).toContain("=== violations ===");
		// The two findings appear as violation lines.
		expect(text).toContain("First issue");
		expect(text).toContain("Second issue");
	});

	it("sorts findings by severity (critical first)", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				findings: [
					finding({ severity: "low", summary: "ZZZ low" }),
					finding({ severity: "critical", summary: "AAA critical" }),
					finding({ severity: "high", summary: "BBB high" }),
				],
			}),
		);
		const critIdx = text.indexOf("AAA critical");
		const highIdx = text.indexOf("BBB high");
		const lowIdx = text.indexOf("ZZZ low");
		expect(critIdx).toBeGreaterThan(0);
		expect(critIdx).toBeLessThan(highIdx);
		expect(highIdx).toBeLessThan(lowIdx);
	});

	it("suppresses _suppressed findings from the violations section", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				findings: [
					finding({ summary: "Visible finding" }),
					{
						...finding({ summary: "Suppressed finding" }),
						_suppressed: true,
					},
				],
			}),
		);
		expect(text).toContain("Visible finding");
		expect(text).not.toContain("Suppressed finding");
	});

	it("suppresses _previouslyRejected findings from the violations section", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				findings: [
					finding({ summary: "Visible finding" }),
					{
						...finding({ summary: "Rejected finding" }),
						_previouslyRejected: true,
					},
				],
			}),
		);
		expect(text).not.toContain("Rejected finding");
	});

	it("includes suppressed and previously-rejected counts in the footer when present", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				counts: {
					total: 1,
					critical: 0,
					high: 1,
					medium: 0,
					low: 0,
					nit: 0,
					suppressed: 2,
					previouslyRejected: 1,
				},
			}),
		);
		expect(text).toContain("2 suppressed");
		expect(text).toContain("1 previously-rejected");
	});

	it("includes validator-refuted count when present", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				counts: {
					total: 1,
					critical: 0,
					high: 1,
					medium: 0,
					low: 0,
					nit: 0,
					suppressed: 0,
					previouslyRejected: 0,
					validatorFalsePositive: 3,
				},
			}),
		);
		expect(text).toContain("3 validator-refuted");
	});

	it("shows FAIL when health score is below the quality gate threshold", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				healthScore: 50,
				qualityGate: {
					status: "fail",
					threshold: 70,
					score: 50,
					reasons: ["health score is below the configured threshold (70)"],
				},
			}),
		);
		expect(text).toContain("⛔ quality gate: FAIL");
	});

	it("shows pass when health score is at or above the threshold", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				healthScore: 90,
				qualityGate: { status: "pass", threshold: 70, score: 90, reasons: [] },
			}),
		);
		expect(text).toContain("✅ quality gate: pass");
	});

	it("shows WARN for validation-degraded reviews", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				reviewStatus: "validation-degraded",
				codeRisk: "clean",
				qualityGate: {
					status: "warn",
					threshold: 70,
					score: 100,
					reasons: ["one or more synthesized findings failed validation"],
				},
			}),
		);
		expect(text).toContain("review status: validation-degraded");
		expect(text).toContain("code risk: clean");
		expect(text).toContain("⚠️ quality gate: WARN");
	});

	it("includes a trend line when prevScore is set", () => {
		const text = formatReviewResultCompact(
			reviewResult({ healthScore: 85, prevScore: 70 }),
		);
		expect(text).toMatch(/trend: 70 \u2192 85 \(\+15\)/);
	});

	it("omits the trend line when prevScore is null", () => {
		const text = formatReviewResultCompact(
			reviewResult({ prevScore: undefined }),
		);
		expect(text).not.toContain("trend:");
	});

	it("includes a trend line with a negative delta", () => {
		const text = formatReviewResultCompact(
			reviewResult({ healthScore: 60, prevScore: 80 }),
		);
		expect(text).toMatch(/trend: 80 \u2192 60 \(-20\)/);
	});

	it("includes the report path when present", () => {
		const text = formatReviewResultCompact(
			reviewResult({ reportPath: "/home/user/review.json" }),
		);
		expect(text).toContain("report: /home/user/review.json");
	});

	it("includes errors when present", () => {
		const text = formatReviewResultCompact(
			reviewResult({ errors: ["lens security failed"] }),
		);
		expect(text).toContain("errors: lens security failed");
	});

	it("includes validation issues count when present", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				validationIssues: [{ findingIndex: 0, reason: "out of scope" }],
			}),
		);
		expect(text).toContain("validation issues: 1");
	});

	it("returns a clean header when there are no findings", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				clean: true,
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
				},
			}),
		);
		expect(text).toMatch(/^DRYKISS clean /m);
		expect(text).toContain("findings: 0");
		expect(text).not.toContain("=== violations ===");
	});

	it("handles a missing source gracefully in the violation line", () => {
		const text = formatReviewResultCompact(
			reviewResult({
				findings: [finding({ source: undefined })],
			}),
		);
		// Missing source renders as a "-" placeholder so the column
		// structure stays parseable: `...:10:-:review`.
		expect(text).toMatch(/DRYKISS:[^:]+:src\/a\.ts:10:-:review/);
	});
});
