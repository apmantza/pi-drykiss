/**
 * Compact violation format (kiss-style).
 *
 * The default `formatReviewResultForTool` output includes a full
 * JSON dump of every finding — useful for the widget, but it
 * bloats the agent's context window. The compact format produces
 * one line per finding in a fixed-width, LLM-consumable shape:
 *
 *   DRYKISS:<severity>:<file>:<line>:<symbol>:<lens> — <diagnosis>; fix: <suggestion>
 *
 * Designed to mirror the shape of `kiss check` output
 * (https://github.com/dsweet99/kiss) so agents that already know
 * how to parse one can parse the other with no retraining.
 *
 * Design rules:
 *   - One violation per line. Never wrap. Long messages are
 *     truncated to keep the line scannable; the full text is
 *     available in the structured `ReviewResult.findings` array
 *     (passed via `details`).
 *   - Missing line and source fields use a `-` placeholder, never
 *     `undefined` or an empty segment. This keeps each line in a
 *     fixed, scannable column layout.
 *   - Severity is lowercased and shortened (`critical` → `crit`,
 *     `medium` → `med`, `nit` → `nit`) so the column is
 *     width-predictable. The compact format is for human/agent
 *     scanning, not for round-tripping — the structured
 *     `ReviewResult` carries the canonical severity.
 *   - The output is sorted by severity (critical first) so the
 *     most important violations appear at the top of the agent's
 *     context, where they're most likely to be read.
 *   - Suppressed and previously-rejected findings are *not*
 *     emitted as violations (they don't need action) but are
 *     counted in a footer line so the totals are honest.
 */

import type { Finding, Severity } from "./types.js";
import type { ReviewResult } from "./review-result.js";

/** Compact severity codes (kiss-style 5-char width). */
const COMPACT_SEVERITY: Record<Severity, string> = {
	critical: "crit",
	high: "high ",
	medium: "med ",
	low: "low ",
	nit: "nit ",
};

/** Severity order for sorting (critical first, nit last). */
const SEVERITY_ORDER: Record<Severity, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	nit: 4,
};

/** Max characters in the diagnosis segment. Longer text is truncated
 *  with an ellipsis. */
const DIAGNOSIS_MAX = 180;

/** Max characters in the fix segment. */
const FIX_MAX = 140;

/** Truncate a string to `max` characters on a word boundary, with an
 *  ellipsis if truncated. Pure. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const slice = text.slice(0, max - 1);
	const lastSpace = slice.lastIndexOf(" ");
	// Prefer a word boundary when one is reasonably close; otherwise
	// hard-truncate. "Reasonably close" = within the last 20 chars.
	const breakPoint = lastSpace >= max - 20 ? lastSpace : max - 1;
	return `${slice.slice(0, breakPoint).trimEnd()}…`;
}

/** Normalize a file path for compact output: repo-relative when
 *  possible, otherwise absolute. Pure. */
function normalizePath(file: string): string {
	// Don't try to be clever about resolving the path — that's the
	// job of git-diff.ts upstream. Just return the input verbatim;
	// the agent can resolve it against cwd. Compacting means making
	// the line readable, not changing what it points at.
	return file.replaceAll(/\\/g, "/");
}

/** Build a single compact violation line. Pure. */
export function formatCompactViolation(finding: Finding): string {
	const sev = COMPACT_SEVERITY[finding.severity] ?? finding.severity;
	const file = normalizePath(finding.file);
	const lineToken = finding.line !== undefined ? String(finding.line) : "-";
	const symbol = finding.source?.trim() || "-";
	const lens = finding.lens && finding.lens !== "all" ? finding.lens : "review";
	const where = `${file}:${lineToken}`;
	const diagnosis = truncate(
		(finding.summary || finding.detail || "unspecified")
			.replace(/\s+/g, " ")
			.trim(),
		DIAGNOSIS_MAX,
	);
	const fixSource = finding.suggestion || finding.detail || "";
	const fix = fixSource
		? truncate(fixSource.replace(/\s+/g, " ").trim(), FIX_MAX)
		: "see diagnosis";
	return `DRYKISS:${sev}:${where}:${symbol}:${lens} — ${diagnosis}; fix: ${fix}`;
}

/** Format a complete review result as a kiss-style compact report.
 *  Returns the text the agent sees; the structured `ReviewResult`
 *  is still passed via `details` for the widget and persistence. */
export function formatReviewResultCompact(
	result: ReviewResult,
	options: { qualityGateThreshold?: number } = {},
): string {
	const threshold = options.qualityGateThreshold ?? 70;
	const counts = result.counts;

	// Header: identity + summary stats.
	const suppressedNote =
		counts.suppressed > 0 ? `, ${counts.suppressed} suppressed` : "";
	const rejectedNote =
		counts.previouslyRejected > 0
			? `, ${counts.previouslyRejected} previously-rejected`
			: "";
	const validatorNote =
		counts.validatorFalsePositive && counts.validatorFalsePositive > 0
			? `, ${counts.validatorFalsePositive} validator-refuted`
			: "";
	// When findings were dropped during validation (out-of-scope files,
	// invalid severity/line, missing required fields), the raw
	// synthesis output may still contain them — but they don't reach
	// the summary line. Surface the drop count so the discrepancy
	// between "summary says 0" and "saved report has N" is visible.
	const rawFindingsCount = result.findings.length;
	const validationDropped =
		rawFindingsCount > 0 &&
		counts.total === 0 &&
		result.validationIssues.length > 0;
	const validationNote = validationDropped
		? ` (raw synthesis output preserved: ${rawFindingsCount} finding(s) — see validation issues below)`
		: "";
	const findingsLine = `findings: ${counts.total} (${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.nit} nit${suppressedNote}${rejectedNote}${validatorNote})${validationNote}`;
	const omissions = result.omissions;
	const omissionNote =
		omissions?.findingBudgetApplied &&
		(omissions.omittedLowPriorityCount > 0 || omissions.omittedNitCount > 0)
			? `omitted by budget: ${omissions.omittedLowPriorityCount} low-priority, ${omissions.omittedNitCount} nit`
			: "";
	const scoreLine = `health score: ${result.healthScore}/100`;
	let trendLine = "";
	if (result.prevScore !== null && result.prevScore !== undefined) {
		const diff = result.healthScore - result.prevScore;
		trendLine = `trend: ${result.prevScore} → ${result.healthScore} (${diff >= 0 ? "+" : ""}${diff})`;
	}
	const qualityGate = formatQualityGate(
		result.qualityGate?.status ??
			(result.healthScore < threshold ? "fail" : "pass"),
	);

	const lines: string[] = [
		`DRYKISS ${result.clean ? "clean" : "review complete"} — ${result.target?.label ?? "scope"}`,
		`review status: ${result.reviewStatus ?? result.status}`,
		`code risk: ${result.codeRisk ?? "unknown"}`,
		`verdict: ${result.verdict}`,
		findingsLine,
		scoreLine,
	];
	if (trendLine) lines.push(trendLine);
	if (omissionNote) lines.push(omissionNote);
	lines.push(qualityGate);

	// Pull active findings (skip suppressed / previously-rejected —
	// they're not actionable). Sort by severity (critical first).
	const active = result.findings
		.filter((f) => !f._suppressed && !f._previouslyRejected)
		.sort(
			(a, b) =>
				SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
				(a.line ?? Number.MAX_SAFE_INTEGER) -
					(b.line ?? Number.MAX_SAFE_INTEGER),
		);

	if (active.length > 0) {
		lines.push("");
		lines.push("=== violations ===");
		for (const f of active) lines.push(formatCompactViolation(f));
	}

	// Footer: errors + path + summary line.
	if (result.validatorError) {
		lines.push(`validator error: ${result.validatorError}`);
	}
	if (result.errors.length > 0) {
		lines.push("");
		lines.push(`errors: ${result.errors.join("; ")}`);
	}
	if (result.reportPath) {
		lines.push(`report: ${result.reportPath}`);
	}
	if (result.summary) {
		lines.push("");
		lines.push(result.summary);
	}
	if (result.validationIssues.length > 0) {
		lines.push("");
		lines.push(
			`validation issues: ${result.validationIssues.length} (see structured result for details)`,
		);
		// Show up to 5 issue reasons inline so the user can see why
		// findings were dropped without opening the structured payload.
		for (const vi of result.validationIssues.slice(0, 5)) {
			lines.push(`  - #${vi.findingIndex}: ${vi.reason}`);
		}
		if (result.validationIssues.length > 5) {
			lines.push(`  ... and ${result.validationIssues.length - 5} more`);
		}
	}

	return lines.join("\n");
}

function formatQualityGate(status: "pass" | "warn" | "fail"): string {
	switch (status) {
		case "pass":
			return "✅ quality gate: pass";
		case "warn":
			return "⚠️ quality gate: WARN";
		case "fail":
		default:
			return "⛔ quality gate: FAIL";
	}
}
