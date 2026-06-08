import { lenientJsonParse } from "./json-utils.js";

export interface ChangedFile {
	readonly path: string;
	readonly status: "modified" | "added" | "renamed" | "copied" | "deleted";
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
];

export type Severity = "critical" | "high" | "medium" | "low" | "nit";

export interface Finding {
	readonly file: string;
	readonly line?: number;
	readonly severity: Severity;
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
	 * Internal marker set by `applySuppressions` (Phase 3). Not part of
	 * the LLM output contract — added post-hoc by the suppression engine.
	 */
	readonly _suppressed?: true;
	/**
	 * Reference to the suppression entry that suppressed this finding.
	 * Populated alongside `_suppressed`.
	 */
	readonly _suppressionRef?: string;
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
	if (raw == null || typeof raw !== "object") {
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
		};
	}
	return {
		file: String(raw.file ?? "unknown"),
		line: typeof raw.line === "number" ? raw.line : undefined,
		severity: String(raw.severity ?? "medium") as Severity,
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
		return {
			findings,
			summary: String(parsed.summary ?? ""),
			verdict: String(
				parsed.verdict ?? "Request changes",
			) as SynthesisResult["verdict"],
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
		};
	} catch {
		return createFallbackSynthesis(
			"Synthesis returned non-JSON output. Raw response available in logs.",
		);
	}
}
