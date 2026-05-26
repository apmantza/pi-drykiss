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
	| "all";

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
