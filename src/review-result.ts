import type { ReviewJob } from "./review-manager.js";
import type { Finding, Severity, SynthesisResult } from "./types.js";
import { computeHealthScore } from "./types.js";
import type { SeverityOverrideRule } from "./config.js";

export interface ReviewResultTarget {
	readonly mode?: string;
	readonly label?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface ReviewResultCounts {
	readonly total: number;
	readonly critical: number;
	readonly high: number;
	readonly medium: number;
	readonly low: number;
	readonly nit: number;
	readonly suppressed: number;
}

export interface ReviewValidationIssue {
	readonly findingIndex: number;
	readonly reason: string;
	readonly finding?: unknown;
}

export interface ReviewResult {
	readonly jobId: string;
	readonly clean: boolean;
	readonly status: ReviewJob["overallStatus"];
	readonly verdict: SynthesisResult["verdict"];
	readonly target?: ReviewResultTarget;
	readonly reportPath?: string;
	readonly files: string[];
	readonly counts: ReviewResultCounts;
	readonly findings: Finding[];
	readonly summary: string;
	readonly errors: string[];
	readonly validationIssues: ReviewValidationIssue[];
	readonly healthScore: number;
	readonly scoreBreakdown: {
		readonly critical: number;
		readonly warning: number;
		readonly suggestion: number;
	};
	/** Health score from the previous run in the same mode (for trend delta). */
	readonly prevScore?: number;
	/**
	 * Mermaid graph TD string showing file-level dependency structure.
	 * Generated during review from the project index. Optional for
	 * reviews without a project index.
	 */
	readonly mermaidGraph?: string;
}

export interface BuildReviewResultOptions {
	readonly target?: ReviewResultTarget;
	/**
	 * Severity overrides to apply after validation (Phase 2).
	 * When a finding's riskCode matches a rule, its severity is changed.
	 * This runs after `validateFindings` but before `countFindings`.
	 */
	readonly severityOverrides?: readonly SeverityOverrideRule[];
	/**
	 * Suppressions to apply (Phase 3). Suppressed findings get
	 * `severity: "nit"` and `_suppressed: true`. They are excluded
	 * from the main count and rendered separately in the widget.
	 */
	readonly suppressions?: ReadonlyArray<{
		riskCode: string;
		pattern: string;
		id: string;
	}>;
	/** Health score from the previous run in the same mode (for trend delta). */
	readonly prevScore?: number;
}

const SEVERITIES: readonly Severity[] = [
	"critical",
	"high",
	"medium",
	"low",
	"nit",
];
const SEVERITY_SET = new Set<Severity>(SEVERITIES);

export function buildReviewResult(
	job: ReviewJob,
	options: BuildReviewResultOptions = {},
): ReviewResult {
	const synthesis = job.synthesisResult;
	const scope = new Set(job.files.map(normalizePath));
	const validation = validateFindings(synthesis?.findings ?? [], scope);
	const overridden = options.severityOverrides
		? applySeverityOverrides(validation.findings, options.severityOverrides)
		: validation.findings;
	const { suppressed, active } = options.suppressions
		? applySuppressions(overridden, options.suppressions)
		: { suppressed: [], active: overridden };
	const counts = countFindings(active);
	const errors = collectErrors(job);
	const verdict = synthesis?.verdict ?? "Request changes";
	const status = job.overallStatus;
	const clean =
		status === "done" &&
		errors.length === 0 &&
		active.length === 0 &&
		verdict === "Approve";
	const hs = computeHealthScore(active);

	return {
		jobId: job.id,
		clean,
		status,
		verdict,
		...(options.target ? { target: options.target } : {}),
		...(job.reviewPath ? { reportPath: job.reviewPath } : {}),
		files: [...job.files],
		counts: {
			...counts,
			suppressed: suppressed.length,
		},
		findings: [...active, ...suppressed],
		summary: synthesis?.summary ?? "Review did not produce a synthesis result.",
		errors,
		validationIssues: validation.issues,
		healthScore: hs.score,
		scoreBreakdown: hs.breakdown,
		...(options.prevScore != null ? { prevScore: options.prevScore } : {}),
		...(synthesis?.mermaidGraph
			? { mermaidGraph: synthesis.mermaidGraph }
			: {}),
	};
}

export function validateFindings(
	findings: readonly Finding[],
	scope: ReadonlySet<string>,
): { findings: Finding[]; issues: ReviewValidationIssue[] } {
	const valid: Finding[] = [];
	const issues: ReviewValidationIssue[] = [];

	findings.forEach((finding, index) => {
		const issue = validateFinding(finding, index, scope);
		if (issue) {
			issues.push(issue);
			return;
		}
		valid.push({ ...finding, file: normalizePath(finding.file) });
	});

	return { findings: valid, issues };
}

function validateFinding(
	finding: Finding,
	index: number,
	scope: ReadonlySet<string>,
): ReviewValidationIssue | null {
	const file = normalizePath(finding.file);
	if (!isSafeRelativePath(file)) {
		return issue(index, "unsafe or missing file path", finding);
	}
	if (!scope.has(file)) {
		return issue(index, `out-of-scope file: ${file}`, finding);
	}
	if (!SEVERITY_SET.has(finding.severity)) {
		return issue(
			index,
			`invalid severity: ${String(finding.severity)}`,
			finding,
		);
	}
	if (finding.line !== undefined && !isPositiveInteger(finding.line)) {
		return issue(index, `invalid line: ${String(finding.line)}`, finding);
	}
	for (const field of [
		"category",
		"summary",
		"detail",
		"suggestion",
	] as const) {
		if (
			typeof finding[field] !== "string" ||
			finding[field].trim().length === 0
		) {
			return issue(index, `missing ${field}`, finding);
		}
	}
	// consequence and source: undefined is allowed (backward compat with
	// legacy persisted findings). When present, must be a non-empty string.
	for (const field of ["consequence", "source"] as const) {
		const value = finding[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim().length === 0) {
			return issue(index, `empty ${field}`, finding);
		}
	}
	return null;
}

function issue(
	findingIndex: number,
	reason: string,
	finding: unknown,
): ReviewValidationIssue {
	return { findingIndex, reason, finding };
}

function countFindings(findings: readonly Finding[]): ReviewResultCounts {
	return {
		total: findings.length,
		critical: findings.filter((f) => f.severity === "critical").length,
		high: findings.filter((f) => f.severity === "high").length,
		medium: findings.filter((f) => f.severity === "medium").length,
		low: findings.filter((f) => f.severity === "low").length,
		nit: findings.filter((f) => f.severity === "nit").length,
		suppressed: 0,
	};
}

function collectErrors(job: ReviewJob): string[] {
	const errors: string[] = [];
	for (const lens of job.lenses) {
		const state = job.states.get(lens);
		if (state?.status === "error") {
			errors.push(`${lens}: ${state.errorMessage ?? "lens failed"}`);
		}
	}
	if (job.synthesisStatus === "error") {
		errors.push(
			`synthesis: ${job.synthesisResult?.summary ?? "synthesis failed"}`,
		);
	}
	return errors;
}

function normalizePath(file: string): string {
	return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSafeRelativePath(file: string): boolean {
	if (!file || file.trim().length === 0) return false;
	if (file.startsWith("/") || file.startsWith("\\")) return false;
	if (/^[A-Za-z]:[\\/]/.test(file)) return false;
	if (/[\x00-\x1f\x7f]/.test(file)) return false;
	const parts = file.split("/");
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}

// ── Phase 2: severity overrides and ignore filtering ────────────────────

/**
 * Apply severity overrides to a list of findings.
 * For each finding with a matching `riskCode`, override the severity
 * to the configured value. Findings without a riskCode are left unchanged.
 */
export function applySeverityOverrides(
	findings: readonly Finding[],
	overrides: readonly SeverityOverrideRule[],
): Finding[] {
	if (overrides.length === 0) return [...findings];
	const overrideMap = new Map<string, SeverityOverrideRule["to"]>();
	for (const rule of overrides) {
		overrideMap.set(rule.riskCode, rule.to);
	}
	return findings.map((f) => {
		const newSeverity = f.riskCode ? overrideMap.get(f.riskCode) : undefined;
		if (!newSeverity) return f;
		return { ...f, severity: newSeverity };
	});
}

/**
 * Filter findings by ignore patterns.
 * Returns only findings whose `file` does NOT match any of the glob patterns.
 * Also returns a count of dropped findings for visibility.
 */
export function filterIgnored(
	findings: readonly Finding[],
	patterns: readonly string[],
): { findings: Finding[]; dropped: number } {
	if (patterns.length === 0) {
		return { findings: [...findings], dropped: 0 };
	}
	const matchers = compileGlobMatchers(patterns);
	const passed: Finding[] = [];
	let dropped = 0;
	for (const f of findings) {
		const file = f.file.replace(/\\/g, "/");
		const match = matchers.some((r) => r.test(file));
		if (match) {
			dropped++;
		} else {
			passed.push(f);
		}
	}
	return { findings: passed, dropped };
}

/**
 * Compile a list of glob patterns into regex matchers.
 * Silently skips invalid patterns so a single bad pattern doesn't crash the review.
 */
function compileGlobMatchers(patterns: readonly string[]): RegExp[] {
	const matchers: RegExp[] = [];
	for (const p of patterns) {
		try {
			matchers.push(globToRegex(p));
		} catch {
			// Skip invalid patterns
		}
	}
	return matchers;
}

/** Convert a simple glob pattern to a regex (supports **, *, ?). */
function globToRegex(pattern: string): RegExp {
	// Normalize backslashes to forward slashes for cross-platform support
	const normalized = pattern.replace(/\\/g, "/");
	let regex = "^";
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "*") {
			// ** matches any number of path segments
			if (normalized[i + 1] === "*") {
				regex += ".*";
				i++; // skip second *
			} else {
				regex += "[^/]*";
			}
		} else if (ch === "?") {
			regex += "[^/]";
		} else if (ch === ".") {
			regex += "\\.";
		} else if (/[.\\+^${}()|[\]\\/]/.test(ch)) {
			// Escape any regex-special characters that aren't glob wildcards
			regex += "\\" + ch;
		} else {
			regex += ch;
		}
	}
	regex += "$";
	return new RegExp(regex);
}

// ── Phase 3: Suppressions ───────────────────────────────────────────────

/**
 * Apply suppressions to a list of findings.
 *
 * A finding is suppressed when:
 *   1. Its `riskCode` matches the suppression's `riskCode` (or suppression
 *      uses wildcard "*" to match any code), AND
 *   2. Its `file` matches the suppression's `pattern` glob.
 *
 * Suppressed findings get `severity: "nit"` and a `_suppressed: true`
 * marker. They are rendered under a collapsed section in the widget but
 * do not contribute to the Health Score.
 *
 * @returns A tuple of [suppressed findings, active findings].
 */
export function applySuppressions(
	findings: readonly Finding[],
	suppressions: ReadonlyArray<{
		riskCode: string;
		pattern: string;
		id: string;
	}>,
): { suppressed: Finding[]; active: Finding[] } {
	if (suppressions.length === 0) {
		return { suppressed: [], active: [...findings] };
	}

	// Pre-compile glob patterns, skipping invalid entries
	const compiled: Array<{
		id: string;
		riskCode: string;
		regex: RegExp;
	}> = [];
	for (const s of suppressions) {
		if (!s.pattern || !s.riskCode) {
			// Skip invalid suppression entries
			continue;
		}
		const regexes = compileGlobMatchers([s.pattern]);
		if (regexes.length === 0) continue;
		compiled.push({
			...s,
			regex: regexes[0],
		});
	}

	const suppressed: Finding[] = [];
	const active: Finding[] = [];

	for (const f of findings) {
		const file = f.file.replace(/\\/g, "/");
		let isSuppressed = false;
		for (const s of compiled) {
			if (s.riskCode !== "*" && s.riskCode !== f.riskCode) continue;
			if (!s.regex.test(file)) continue;
			suppressed.push({
				...f,
				severity: "nit" as Severity,
				_suppressed: true,
				_suppressionRef: s.id,
			});
			isSuppressed = true;
			break;
		}
		if (!isSuppressed) {
			active.push(f);
		}
	}

	return { suppressed, active };
}

/**
 * Check if a suppression has expired.
 * Returns true if the suppression has passed its `expiresAt` date.
 * When `expiresAt` is undefined, the suppression never expires.
 */
export function isSuppressionExpired(suppression: {
	expiresAt?: string;
}): boolean {
	if (!suppression.expiresAt) return false;
	try {
		const expiry = new Date(suppression.expiresAt);
		return expiry.getTime() <= Date.now();
	} catch {
		// Invalid date — treat as never-expiring and emit a warning
		console.warn(
			"DRYKISS: Invalid expiresAt date for suppression:",
			suppression.expiresAt,
		);
		return false;
	}
}

/**
 * Find which suppressions are expired from a list.
 * Returns the ids of expired suppressions.
 */
export function getExpiredSuppressionIds(
	suppressions: ReadonlyArray<{ id: string; expiresAt?: string }>,
): string[] {
	return suppressions.filter((s) => isSuppressionExpired(s)).map((s) => s.id);
}
