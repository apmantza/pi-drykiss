import type {
	ReviewJobState,
	ReviewValidationIssue,
} from "./review-lifecycle-types.js";
import type { Finding, Severity, SynthesisResult } from "./types.js";
import { computeHealthScore } from "./types.js";
import type { SeverityOverrideRule } from "./config.js";
import { compileGlobMatchers, matchesAnyGlob } from "./glob-utils.js";
import { LOG_PREFIX, SEVERITY_VALUES } from "./constants.js";
import { applyRejections, type RejectionRecord } from "./rejections.js";
import { applyFindingBudget, type FindingBudget } from "./finding-budget.js";
import {
	finalizeReviewOutcome,
	type CodeRisk,
	type ReviewQualityGate,
	type ReviewStatus,
} from "./review-finalizer.js";

const REQUIRED_FINDING_STRING_FIELDS = [
	"category",
	"summary",
	"detail",
	"suggestion",
] as const;
const OPTIONAL_FINDING_STRING_FIELDS = ["consequence", "source"] as const;

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
	/**
	 * Findings that matched a previously-recorded rejection. They are
	 * surfaced (never hidden) but downranked to the bottom of the
	 * rendered list and excluded from `total` and the health score.
	 */
	readonly previouslyRejected: number;
	/**
	 * Validator stage output. Populated when validation ran.
	 * Refuted findings are retained in `discardedFindings`, never in these
	 * active counts or the deterministic outcome.
	 */
	readonly validatorReal?: number;
	readonly validatorFalsePositive?: number;
	readonly validatorUnverified?: number;
}

export interface ReviewResult {
	readonly jobId: string;
	readonly clean: boolean;
	/** Legacy execution status retained for persisted-review compatibility. */
	readonly status: ReviewJobState["overallStatus"];
	/** Completion quality, separate from risk in the reviewed code. */
	readonly reviewStatus: ReviewStatus;
	/** Risk derived from active, normalized findings. */
	readonly codeRisk: CodeRisk;
	/** Configured quality-gate evaluation with its explicit reasons. */
	readonly qualityGate: ReviewQualityGate;
	readonly verdict: SynthesisResult["verdict"];
	readonly verdictSource: "deterministic";
	readonly omissions?: {
		readonly findingBudgetApplied: boolean;
		readonly omittedLowPriorityCount: number;
		readonly omittedNitCount: number;
	};
	readonly target?: ReviewResultTarget;
	readonly reportPath?: string;
	readonly files: string[];
	readonly counts: ReviewResultCounts;
	readonly findings: Finding[];
	/** Findings refuted by the validator, retained for auditability only. */
	readonly discardedFindings?: Finding[];
	/** Best-effort reason when the validator failed open. */
	readonly validatorError?: string;
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
	/** Configured minimum health score for a passing quality gate. */
	readonly qualityGateThreshold?: number;
	/**
	 * Mermaid graph TD string showing file-level dependency structure.
	 * Generated during review from the project index. Optional for
	 * reviews without a project index.
	 */
	readonly mermaidGraph?: string;
}

export interface BuildReviewResultOptions {
	/** Override synthesized findings after a verification pass. */
	readonly findings?: readonly Finding[];
	/** Validator-refuted findings to retain outside the active result. */
	readonly discardedFindings?: readonly Finding[];
	readonly validatorCounts?: {
		readonly real: number;
		readonly falsePositive: number;
		readonly unverified: number;
	};
	readonly validatorError?: string;
	readonly target?: ReviewResultTarget;
	/**
	 * Severity overrides to apply after validation (Phase 2).
	 * When a finding's riskCode matches a rule, its severity is changed.
	 * This runs after `validateFindings` but before `countFindings`.
	 */
	readonly severityOverrides?: readonly SeverityOverrideRule[];
	/**
	 * Findings in these paths are removed before suppression, counting, and
	 * deterministic outcome derivation so every visible result field agrees.
	 */
	readonly ignorePatterns?: readonly string[];
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
	/**
	 * Recorded-rejection store for the project. Findings that match a
	 * past rejection (same file + co-located/paraphrased message) are
	 * tagged `_previouslyRejected: true` and downranked to the bottom
	 * of the rendered list — never hidden, never counted toward the
	 * health score.
	 */
	readonly rejections?: readonly RejectionRecord[];
	/** Health score from the previous run in the same mode (for trend delta). */
	readonly prevScore?: number;
	/** Configured minimum health score for a passing quality gate. */
	readonly qualityGateThreshold?: number;
	/** Optional deterministic cap applied after suppression/rejection handling. */
	readonly findingBudget?: FindingBudget;
	/** Scope-preparation failures collected before lens execution. */
	readonly preparationErrors?: readonly string[];
}

const SEVERITY_SET = SEVERITY_VALUES;

export function buildReviewResult(
	job: ReviewJobState,
	options: BuildReviewResultOptions = {},
): ReviewResult {
	const synthesis = job.synthesisResult;
	const scope = new Set(job.files.map(normalizePath));
	const discardedKeys = new Set(
		(options.discardedFindings ?? []).map(getFindingIdentity),
	);
	const sourceFindings = (options.findings ?? synthesis?.findings ?? []).filter(
		(finding) => !discardedKeys.has(getFindingIdentity(finding)),
	);
	const validation = validateFindings(sourceFindings, scope);
	const validationIssues = validation.issues;
	const overridden = options.severityOverrides
		? applySeverityOverrides(validation.findings, options.severityOverrides)
		: validation.findings;
	const ignored = options.ignorePatterns
		? filterIgnored(overridden, options.ignorePatterns)
		: { findings: overridden, dropped: 0 };
	const { suppressed, active } = options.suppressions
		? applySuppressions(ignored.findings, options.suppressions)
		: { suppressed: [], active: ignored.findings };
	// applyRejections runs AFTER suppressions so a suppressed+rejected
	// finding is just suppressed (the rejection is moot once it's gone).
	// A rejection only downranks an *active* finding, never a suppressed
	// one. Pure reorder — never hides input.
	const reordered = options.rejections
		? applyRejections(active, options.rejections)
		: active;
	const activeFresh = reordered.filter(
		(f) => !(f as Finding & { _previouslyRejected?: true })._previouslyRejected,
	);
	const previouslyRejected = reordered.filter(
		(f) => (f as Finding & { _previouslyRejected?: true })._previouslyRejected,
	);
	const budgeted = applyFindingBudget(activeFresh, options.findingBudget);
	const baseCounts = countFindings(
		budgeted.findings,
		suppressed.length,
		previouslyRejected.length,
	);
	const counts: ReviewResultCounts = {
		...baseCounts,
		...(options.validatorCounts
			? {
					validatorReal: options.validatorCounts.real,
					validatorFalsePositive: options.validatorCounts.falsePositive,
					validatorUnverified: options.validatorCounts.unverified,
				}
			: {}),
	};
	const errors = collectErrors(job, options.preparationErrors);
	// Health reflects only active code findings. Review failures and malformed
	// synthesis output are represented independently by reviewStatus and the
	// quality gate instead of masquerading as critical code risk.
	const hs = computeHealthScore(budgeted.findings);
	const outcome = finalizeReviewOutcome({
		findings: budgeted.findings,
		errors,
		validationIssues,
		healthScore: hs.score,
		qualityGateThreshold: options.qualityGateThreshold,
	});

	return {
		jobId: job.id,
		clean: outcome.clean,
		status: job.overallStatus,
		reviewStatus: outcome.reviewStatus,
		codeRisk: outcome.codeRisk,
		qualityGate: outcome.qualityGate,
		verdict: outcome.verdict,
		verdictSource: outcome.verdictSource,
		omissions: {
			findingBudgetApplied: budgeted.applied,
			omittedLowPriorityCount: budgeted.omittedLowPriorityCount,
			omittedNitCount: budgeted.omittedNitCount,
		},
		...(options.target ? { target: options.target } : {}),
		...(job.reviewPath ? { reportPath: job.reviewPath } : {}),
		files: [...job.files],
		counts,
		// Render order: fresh active → suppressed → previously-rejected.
		// The last bucket is the "downrank" — same visual treatment as
		// suppressed (collapsed under its own section in the widget).
		findings: [...budgeted.findings, ...suppressed, ...previouslyRejected],
		...(options.discardedFindings && options.discardedFindings.length > 0
			? { discardedFindings: [...options.discardedFindings] }
			: {}),
		...(options.validatorError
			? { validatorError: options.validatorError }
			: {}),
		summary: formatSummary(
			synthesis?.summary,
			ignored.dropped,
			options.discardedFindings?.length ?? 0,
			validationIssues.length,
		),
		errors,
		validationIssues,
		healthScore: hs.score,
		scoreBreakdown: hs.breakdown,
		...(options.prevScore !== null && options.prevScore !== undefined
			? { prevScore: options.prevScore }
			: {}),
		...(options.qualityGateThreshold !== undefined
			? { qualityGateThreshold: options.qualityGateThreshold }
			: {}),
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
		const coercedLine =
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			finding.line !== undefined && typeof (finding.line as any) === "string"
				? // eslint-disable-next-line @typescript-eslint/no-explicit-any
					parseInt(finding.line as any, 10)
				: finding.line;
		valid.push({
			...finding,
			file: normalizePath(finding.file),
			...(coercedLine !== finding.line ? { line: coercedLine } : {}),
		});
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
	if (finding.line !== undefined) {
		const coerced =
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			typeof (finding.line as any) === "string"
				? // eslint-disable-next-line @typescript-eslint/no-explicit-any
					parseInt(finding.line as any, 10)
				: finding.line;
		if (!isPositiveInteger(coerced)) {
			return issue(index, `invalid line: ${String(finding.line)}`, finding);
		}
	}
	for (const field of REQUIRED_FINDING_STRING_FIELDS) {
		if (
			typeof finding[field] !== "string" ||
			finding[field].trim().length === 0
		) {
			return issue(index, `missing ${field}`, finding);
		}
	}
	// consequence and source: undefined is allowed (backward compat with
	// legacy persisted findings). When present, must be a non-empty string.
	for (const field of OPTIONAL_FINDING_STRING_FIELDS) {
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

function countFindings(
	findings: readonly Finding[],
	suppressedCount: number,
	previouslyRejectedCount: number,
): ReviewResultCounts {
	return {
		total: findings.length,
		critical: findings.filter((f) => f.severity === "critical").length,
		high: findings.filter((f) => f.severity === "high").length,
		medium: findings.filter((f) => f.severity === "medium").length,
		low: findings.filter((f) => f.severity === "low").length,
		nit: findings.filter((f) => f.severity === "nit").length,
		suppressed: suppressedCount,
		previouslyRejected: previouslyRejectedCount,
		// Validator counts are only populated when the validator stage runs.
		// Leaving them undefined makes it clear the stage did not run.
	};
}

function formatSummary(
	summary: string | undefined,
	ignoredCount: number,
	discardedCount: number,
	validationDroppedCount: number,
): string {
	const base = summary ?? "Review did not produce a synthesis result.";
	const notes: string[] = [];
	if (ignoredCount > 0) {
		notes.push(
			`DRYKISS dropped ${ignoredCount} finding(s) matching ignore patterns.`,
		);
	}
	if (discardedCount > 0) {
		notes.push(
			`Validator refuted ${discardedCount} finding(s); see discardedFindings for audit details.`,
		);
	}
	if (validationDroppedCount > 0) {
		notes.push(
			`${validationDroppedCount} finding(s) dropped due to validation issues.`,
		);
	}
	return notes.length > 0 ? `${base}\n(${notes.join(" ")})` : base;
}

function collectErrors(
	job: ReviewJobState,
	preparationErrors: readonly string[] = [],
): string[] {
	const errors = [...preparationErrors];
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
	return String(file).replaceAll(/\\/g, "/").replace(/^\.\//, "");
}

export function getFindingIdentity(finding: Finding): string {
	return JSON.stringify([
		normalizePath(finding.file),
		finding.line ?? null,
		finding.category,
		finding.summary,
		finding.detail,
		finding.suggestion,
		finding.lens ?? null,
		finding.riskCode ?? null,
	]);
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
	const noRiskCodeFindings: Finding[] = [];
	const result = findings.map((f) => {
		if (!f.riskCode) {
			noRiskCodeFindings.push(f);
			return f;
		}
		const newSeverity = overrideMap.get(f.riskCode);
		if (!newSeverity) return f;
		return { ...f, severity: newSeverity };
	});
	if (noRiskCodeFindings.length > 0) {
		const sample = noRiskCodeFindings[0].file;
		console.warn(
			`${LOG_PREFIX} ${noRiskCodeFindings.length} finding(s) lack a riskCode and were not eligible for severity overrides (sample file: ${sample})`,
		);
	}
	return result;
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
	const passed: Finding[] = [];
	let dropped = 0;
	for (const f of findings) {
		if (matchesAnyGlob(f.file, patterns)) {
			dropped++;
		} else {
			passed.push(f);
		}
	}
	return { findings: passed, dropped };
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
			console.warn(
				`${LOG_PREFIX} Skipping invalid suppression entry (missing pattern or riskCode): ${s.id}`,
			);
			continue;
		}
		const regexes = compileGlobMatchers([s.pattern]);
		if (regexes.length === 0) {
			console.warn(
				`${LOG_PREFIX} Skipping suppression entry with invalid pattern: ${s.id}`,
			);
			continue;
		}
		compiled.push({
			...s,
			regex: regexes[0],
		});
	}

	const suppressed: Finding[] = [];
	const active: Finding[] = [];

	for (const f of findings) {
		const file = f.file.replaceAll(/\\/g, "/");
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
