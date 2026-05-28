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
	readonly confidence?: "confirmed" | "likely" | "suspect";
	readonly lens?: ReviewLens;
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
 */
export function mapRawToFinding(raw: any, lens?: ReviewLens): Finding {
	return {
		file: String(raw.file ?? "unknown"),
		line: typeof raw.line === "number" ? raw.line : undefined,
		severity: String(raw.severity ?? "medium") as Severity,
		category: String(raw.category ?? ""),
		summary: String(raw.summary ?? ""),
		detail: String(raw.detail ?? raw.summary ?? ""),
		suggestion: String(raw.suggestion ?? ""),
		confidence: raw.confidence
			? (String(raw.confidence) as "confirmed" | "likely" | "suspect")
			: undefined,
		lens,
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
