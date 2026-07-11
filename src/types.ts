import { lenientJsonParse, isPlainObject } from "./json-utils.js";
import { SEVERITY_VALUES } from "./constants.js";

function normalizeSeverity(raw: unknown): Severity {
	const s = typeof raw === "string" ? raw : "medium";
	return SEVERITY_VALUES.has(s) ? (s as Severity) : "medium";
}

const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

function normalizePriority(
	raw: unknown,
): "P0" | "P1" | "P2" | "P3" | undefined {
	const p = typeof raw === "string" ? raw.toUpperCase() : undefined;
	return p && VALID_PRIORITIES.has(p)
		? (p as "P0" | "P1" | "P2" | "P3")
		: undefined;
}

export interface ChangedFile {
	readonly path: string;
	readonly status:
		| "modified"
		| "added"
		| "renamed"
		| "copied"
		| "deleted"
		| "unchanged";
	readonly language: string | null;
}

export interface ReviewOptions {
	readonly files: readonly string[];
	readonly ref: string;
	readonly staged: boolean;
	readonly all: boolean;
}

export interface LensReview {
	readonly lens: ReviewLens;
	readonly findings: Finding[];
	readonly rawOutput: string;
}

export type ReviewLens =
	| "simplicity"
	| "deduplication"
	| "clarity"
	| "resilience"
	| "architecture"
	| "tests"
	| "security"
	| "docs"
	| "all";

/** All reviewable lens names (excludes "all"). */
export const LENS_NAMES: readonly Exclude<ReviewLens, "all">[] = [
	"simplicity",
	"deduplication",
	"clarity",
	"resilience",
	"architecture",
	"tests",
	"security",
	"docs",
];

export type Severity = "critical" | "high" | "medium" | "low" | "nit";

export interface Finding {
	readonly file: string;
	readonly line?: number;
	readonly severity: Severity;
	/**
	 * Review priority tag, independent of severity. Mirrors Codex-style
	 * priority levels:
	 *   - P0: drop everything to fix (blocking release/operations).
	 *   - P1: urgent, should be addressed in the next cycle.
	 *   - P2: normal, to be fixed eventually.
	 *   - P3: low, nice to have.
	 */
	readonly priority?: "P0" | "P1" | "P2" | "P3";
	readonly category: string;
	readonly summary: string;
	readonly detail: string;
	readonly suggestion: string;
	/**
	 * What goes wrong downstream if the issue is left in place. Optional for
	 * backward compat with persisted reviews; new findings produced by lens
	 * runs should always populate this with a non-empty string.
	 */
	readonly consequence?: string;
	/**
	 * Where in the codebase the smell lives — typically the function,
	 * class, or module name. Optional for backward compat; new findings
	 * should populate it.
	 */
	readonly source?: string;
	readonly fixability?: "quick-fix" | "guided" | "manual";
	readonly confidence?: "confirmed" | "likely" | "suspect";
	readonly lens?: ReviewLens;
	/**
	 * Risk code from the project's RISK_CODES list. Used by config
	 * (Phase 2: disable/severity/ignore/focus). Optional until Phase 2
	 * ships the per-lens risk code catalogue.
	 */
	readonly riskCode?: string;
	/**
	 * Recommended action for the author.
	 *   - fix: apply the suggested change (high-confidence, concrete).
	 *   - discuss: challenge the author's intent or needs human judgment.
	 *   - ignore: informational / nit, no action required.
	 */
	readonly action?: "fix" | "discuss" | "ignore";
	/**
	 * Aggregate risk level of the finding, independent of severity.
	 *   - low: localized, easy to verify, limited blast radius.
	 *   - medium: could affect correctness or maintainability if missed.
	 *   - high: security, reliability, or architectural risk.
	 */
	readonly riskLevel?: "low" | "medium" | "high";
	/**
	 * Internal marker set by `applySuppressions` (Phase 3). Not part of
	 * the LLM output contract — added post-hoc by the suppression engine.
	 */
	readonly _suppressed?: true;
	/**
	 * Reference to the suppression entry that suppressed this finding.
	 * Populated alongside `_suppressed`.
	 */
	readonly _suppressionRef?: string;
	/**
	 * Internal marker set by `applyRejections` in `./rejections.ts`. A
	 * finding matches a past rejection (same file + co-located/paraphrased
	 * message); it is downranked to the bottom of the rendered list but
	 * never hidden. Not part of the LLM output contract.
	 */
	readonly _previouslyRejected?: true;
	/**
	 * Number of DISTINCT lenses that contributed to this bucket (1 for a
	 * singleton). Populated by `clusterAndFlatten` in `./bucketing.ts`
	 * before the synthesis prompt is built, so the LLM can see which
	 * findings were flagged by multiple independent reviewers.
	 * Not part of the LLM output contract.
	 */
	readonly _bucketVotes?: number;
	/**
	 * Distinct lens names that contributed to this bucket, sorted
	 * alphabetically. Populated alongside `_bucketVotes` by
	 * `clusterAndFlatten`. Empty for singletons.
	 * Not part of the LLM output contract.
	 */
	readonly _bucketLenses?: ReviewLens[];
	/**
	 * Internal marker set by the validator stage (see
	 * `./validator.ts`). Reflects whether an independent LLM pass tried
	 * to falsify this finding:
	 *   - "real": validator confirmed the finding is triggered by a
	 *     concrete input or execution path.
	 *   - "false-positive": validator refuted the finding. It is retained in
	 *     `ReviewResult.discardedFindings` but excluded from active risk.
	 *   - "unverified": validator was unavailable, errored, or could
	 *     not conclude from the truncated context. It remains active.
	 * Not part of the LLM output contract — added post-hoc.
	 */
	readonly _validatorVerdict?: "real" | "false-positive" | "unverified";
	/**
	 * Optional one-sentence justification recorded alongside
	 * `_validatorVerdict`. Names the concrete trigger (for "real")
	 * or the reason the defect cannot occur (for "false-positive").
	 * Optional: only populated when the validator returned a verdict.
	 */
	readonly _validatorJustification?: string;
}

export function shouldApproveEmptyReview(
	findingCount: number,
	errorCount = 0,
	validationIssueCount = 0,
): boolean {
	return findingCount === 0 && errorCount === 0 && validationIssueCount === 0;
}

export interface SynthesisResult {
	readonly findings: Finding[];
	readonly summary: string;
	readonly criticalCount: number;
	readonly highCount: number;
	readonly mediumCount: number;
	readonly lowCount: number;
	readonly nitCount: number;
	readonly verdict: "Approve" | "Request changes" | "Needs security review";
	readonly healthScore: number;
	readonly scoreBreakdown: ScoreBreakdown;
	/**
	 * Mermaid graph TD string showing file-level dependency structure.
	 * Generated during synthesis from the project index. Optional for
	 * backward compat with persisted reviews; new runs should populate
	 * this when the project index is available.
	 */
	readonly mermaidGraph?: string;
	/**
	 * Files that played a role in the review (read, modified, referenced).
	 * Optional; populated when the synthesis can provide a clean index.
	 */
	readonly files?: readonly ReviewedFile[];
	/**
	 * Follow-up actions the author should take after addressing findings.
	 * Optional; populated when the review surfaces deferred work.
	 */
	readonly nextSteps?: readonly string[];
	/**
	 * Work that was intentionally not completed in this review and why.
	 * Optional; populated when a lens or verification step could not finish.
	 */
	readonly notDone?: readonly NotDoneItem[];
	/**
	 * Extension point for lens-specific structured output.
	 * Optional; e.g. { mermaidGraph: "..." } from the architecture lens.
	 */
	readonly extensions?: Record<string, unknown>;
}

/** A file referenced or inspected during the review. */
export interface ReviewedFile {
	readonly path: string;
	readonly role?: "read" | "modified" | "referenced";
	readonly description?: string;
	readonly snippet?: string;
	readonly ranges?: readonly { start: number; end: number; label?: string }[];
}

/** An item of unfinished work surfaced by the review. */
export interface NotDoneItem {
	readonly item: string;
	readonly reason: string;
	readonly blocker?: string;
	readonly nextStep?: string;
}

/** Brooks-lint severity tiers for health-score computation. */
export type SeverityTier = "critical" | "warning" | "suggestion";

export interface ScoreBreakdown {
	readonly critical: number;
	readonly warning: number;
	readonly suggestion: number;
}

/**
 * Map DRYKISS severity levels to brooks-lint's 3-tier scoring system.
 *   critical → critical
 *   high, medium → warning
 *   low, nit → suggestion
 */
export function severityToTier(severity: Severity): SeverityTier {
	switch (severity) {
		case "critical":
			return "critical";
		case "high":
		case "medium":
			return "warning";
		case "low":
		case "nit":
			return "suggestion";
		default:
			return "suggestion";
	}
}

/**
 * Compute the health score from an array of findings.
 * Formula: 100 − 15·critical − 5·warning − 1·suggestion, floor 0.
 */
export function computeHealthScore(findings: readonly Finding[]): {
	score: number;
	breakdown: ScoreBreakdown;
} {
	const b = { critical: 0, warning: 0, suggestion: 0 };
	for (const f of findings) {
		const tier = severityToTier(f.severity);
		b[tier]++;
	}
	const breakdown: ScoreBreakdown = { ...b };
	const score = Math.max(
		0,
		100 -
			breakdown.critical * 15 -
			breakdown.warning * 5 -
			breakdown.suggestion * 1,
	);
	return { score, breakdown };
}

export interface TurnEdits {
	readonly files: readonly EditedFile[];
	readonly turnIndex: number;
}

export interface EditedFile {
	readonly path: string;
	readonly language: string | null;
}

/**
 * Map a raw JSON object from LLM output to a Finding.
 * Handles missing/undefined fields with sensible defaults.
 *
 * `consequence` and `source` always coerce to a string (empty string
 * when missing). This is what the validator expects: undefined means
 * "legacy persisted finding", empty string means "LLM said nothing",
 * non-empty means a real field. Pushing toward empty-string default
 * (rather than undefined) makes new lens output visibly different from
 * legacy data and makes the validator's "must be non-empty" rule
 * meaningful.
 */
export function mapRawToFinding(raw: any, lens?: ReviewLens): Finding {
	if (raw === null || raw === undefined || typeof raw !== "object") {
		return {
			file: "unknown",
			severity: "medium",
			category: "",
			summary: "",
			detail: "",
			suggestion: "",
			consequence: undefined,
			source: undefined,
			fixability: undefined,
			confidence: undefined,
			lens,
			riskCode: undefined,
			action: undefined,
			riskLevel: undefined,
			priority: undefined,
		};
	}
	return {
		file: String(raw.file ?? "unknown"),
		line: typeof raw.line === "number" ? raw.line : undefined,
		severity: normalizeSeverity(raw.severity),
		category: String(raw.category ?? ""),
		summary: String(raw.summary ?? ""),
		detail: String(raw.detail ?? raw.summary ?? ""),
		suggestion: String(raw.suggestion ?? ""),
		consequence: raw.consequence ? String(raw.consequence) : undefined,
		source: raw.source ? String(raw.source) : undefined,
		fixability: raw.fixability
			? (String(raw.fixability) as "quick-fix" | "guided" | "manual")
			: undefined,
		confidence: raw.confidence
			? (String(raw.confidence) as "confirmed" | "likely" | "suspect")
			: undefined,
		lens,
		riskCode: raw.riskCode ? String(raw.riskCode) : undefined,
		action: isValidAction(raw.action) ? raw.action : undefined,
		riskLevel: isValidRiskLevel(raw.riskLevel) ? raw.riskLevel : undefined,
		priority: normalizePriority(raw.priority),
	};
}

/**
 * Parse a JSON array of findings from LLM output.
 * Returns empty array on failure (does not throw).
 */
export function parseFindingsArray(raw: unknown, lens?: ReviewLens): Finding[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((f) => mapRawToFinding(f, lens));
}

function isValidAction(value: unknown): value is Finding["action"] {
	return value === "fix" || value === "discuss" || value === "ignore";
}

function isValidRiskLevel(value: unknown): value is Finding["riskLevel"] {
	return value === "low" || value === "medium" || value === "high";
}

/** Create a fallback SynthesisResult for error cases. */
export function createFallbackSynthesis(summary: string): SynthesisResult {
	const empty: Finding[] = [];
	const hs = computeHealthScore(empty);
	return {
		findings: empty,
		summary,
		verdict: "Request changes",
		criticalCount: 0,
		highCount: 0,
		mediumCount: 0,
		lowCount: 0,
		nitCount: 0,
		healthScore: hs.score,
		scoreBreakdown: hs.breakdown,
	};
}

/**
 * Parse raw LLM synthesis output into a SynthesisResult.
 * Returns a fallback result on parse failure.
 */
export function parseSynthesis(raw: string): SynthesisResult {
	try {
		const parsed = lenientJsonParse<Record<string, unknown>>(raw);
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("Not an object");
		}
		const findings = Array.isArray(parsed.findings)
			? (parsed.findings as any[]).map((f) => mapRawToFinding(f))
			: [];
		const hs = computeHealthScore(findings);
		// Safety override: an empty findings list must never claim a
		// non-approving verdict. This prevents a confused synthesizer from
		// emitting "Needs security review" or "Request changes" when it has
		// no evidence to support that verdict.
		const verdict = shouldApproveEmptyReview(findings.length)
			? "Approve"
			: (String(
					parsed.verdict ?? "Request changes",
				) as SynthesisResult["verdict"]);
		const summary =
			findings.length === 0 && !String(parsed.summary ?? "").trim()
				? "No issues found"
				: String(parsed.summary ?? "");
		return {
			findings,
			summary,
			verdict,
			criticalCount: findings.filter((f) => f.severity === "critical").length,
			highCount: findings.filter((f) => f.severity === "high").length,
			mediumCount: findings.filter((f) => f.severity === "medium").length,
			lowCount: findings.filter((f) => f.severity === "low").length,
			nitCount: findings.filter((f) => f.severity === "nit").length,
			healthScore: hs.score,
			scoreBreakdown: hs.breakdown,
			...(typeof parsed.mermaidGraph === "string" && parsed.mermaidGraph.trim()
				? { mermaidGraph: String(parsed.mermaidGraph).trim() }
				: {}),
			...(Array.isArray(parsed.files)
				? { files: parsed.files.filter(isReviewedFile) }
				: {}),
			...(Array.isArray(parsed.nextSteps)
				? { nextSteps: parsed.nextSteps.filter((s) => typeof s === "string") }
				: {}),
			...(Array.isArray(parsed.notDone)
				? { notDone: parsed.notDone.filter(isNotDoneItem) }
				: {}),
			...(isPlainObject(parsed.extensions)
				? { extensions: parsed.extensions }
				: {}),
		};
	} catch {
		return createFallbackSynthesis(
			"Synthesis returned non-JSON output. Raw response available in logs.",
		);
	}
}

function isReviewedFile(value: unknown): value is ReviewedFile {
	return isPlainObject(value) && typeof value.path === "string";
}

function isNotDoneItem(value: unknown): value is NotDoneItem {
	return (
		isPlainObject(value) &&
		typeof value.item === "string" &&
		typeof value.reason === "string"
	);
}
