/**
 * risk-codes.ts — Typed barrel for the DRYKISS + brooks-lint risk code catalogue.
 *
 * The human-readable catalogue is in `_shared/risk-codes.md` (with frontmatter).
 * This file is the runtime source of truth used by config validation,
 * constraint building, and (eventually) the suppression matcher.
 *
 * This is structured metadata — it does not violate the .md-only prompt-text
 * constraint enforced by `scripts/check-no-prompt-literals.ts`. The check
 * script only flags identifier-shaped names that look like prompt bodies
 * (see the script's identifier regex for the exact pattern), and constant
 * assignments starting with system-prompt openings. Neither rule fires on
 * this file.
 */

interface RiskCodeDefinition {
	/** Short identifier (e.g. "R1", "K1"). */
	readonly code: string;
	/** Human-readable name. */
	readonly name: string;
	/** The diagnostic question the lens asks itself. */
	readonly diagnosticQuestion: string;
	/** Lenses that can produce findings of this risk. */
	readonly sources: readonly string[];
	/** Suggested default severity (informational; override via `severity` config). */
	readonly defaultSeverity: "critical" | "high" | "medium" | "low" | "nit";
	/** "rot" (R*) or "test" (T*) or DRYKISS-specific category. */
	readonly category: "rot" | "test" | "drykiss";
}

/**
 * The full risk code catalogue. Order matters for UI display: the
 * validation and config code treats this as a Record (no order), but
 * consumers that render the catalogue (e.g. the widget) should iterate
 * in declaration order.
 */
export const RISK_CODES = {
	// R-codes (rot) — borrowed from brooks-lint
	R1: {
		code: "R1",
		name: "Divergent change",
		diagnosticQuestion:
			"Does the same conceptual change require edits in N places?",
		sources: ["simplicity", "deduplication"],
		defaultSeverity: "high",
		category: "rot",
	},
	R2: {
		code: "R2",
		name: "Shotgun surgery",
		diagnosticQuestion: "Does a small change force a wide fan-out of edits?",
		sources: ["simplicity", "deduplication"],
		defaultSeverity: "high",
		category: "rot",
	},
	R3: {
		code: "R3",
		name: "Inappropriate intimacy",
		diagnosticQuestion:
			"Do classes/modules know too much about each other's internals?",
		sources: ["architecture", "clarity"],
		defaultSeverity: "medium",
		category: "rot",
	},
	R4: {
		code: "R4",
		name: "Refactor backlog",
		diagnosticQuestion:
			"Are TODOs / `// FIXME` / hacks accumulating without attention?",
		sources: ["simplicity", "resilience"],
		defaultSeverity: "low",
		category: "rot",
	},
	R5: {
		code: "R5",
		name: "Lost intent",
		diagnosticQuestion:
			"Are magic numbers, opaque flags, or unexplained names creeping in?",
		sources: ["clarity"],
		defaultSeverity: "low",
		category: "rot",
	},
	R6: {
		code: "R6",
		name: "Leaky abstraction",
		diagnosticQuestion:
			"Does the API expose implementation details to its callers?",
		sources: ["architecture", "clarity"],
		defaultSeverity: "high",
		category: "rot",
	},
	// T-codes (test) — borrowed from brooks-lint
	T1: {
		code: "T1",
		name: "Missing test",
		diagnosticQuestion:
			"Is there a test that would catch a regression in this code path?",
		sources: ["tests"],
		defaultSeverity: "medium",
		category: "test",
	},
	T2: {
		code: "T2",
		name: "Brittle assertion",
		diagnosticQuestion:
			"Does the test rely on implementation details (mocks, snapshot, exact string)?",
		sources: ["tests"],
		defaultSeverity: "low",
		category: "test",
	},
	T3: {
		code: "T3",
		name: "Tautological test",
		diagnosticQuestion:
			"Does the test re-implement the production logic, then compare to itself?",
		sources: ["tests"],
		defaultSeverity: "medium",
		category: "test",
	},
	T4: {
		code: "T4",
		name: "Coverage gap on failure path",
		diagnosticQuestion: "Are error / boundary / null paths exercised?",
		sources: ["tests", "resilience"],
		defaultSeverity: "medium",
		category: "test",
	},
	T5: {
		code: "T5",
		name: "Untested integration",
		diagnosticQuestion: "Do modules communicate correctly across boundaries?",
		sources: ["tests", "architecture"],
		defaultSeverity: "medium",
		category: "test",
	},
	T6: {
		code: "T6",
		name: "Property violation",
		diagnosticQuestion:
			"Does the code violate an invariant the type system should enforce?",
		sources: ["tests", "resilience", "security"],
		defaultSeverity: "high",
		category: "test",
	},
	// DRYKISS extensions
	K1: {
		code: "K1",
		name: "KISS violation",
		diagnosticQuestion: "Is the code more complex than the problem demands?",
		sources: ["simplicity"],
		defaultSeverity: "medium",
		category: "drykiss",
	},
	D1: {
		code: "D1",
		name: "Duplication",
		diagnosticQuestion: "Is the same knowledge expressed in two places?",
		sources: ["deduplication"],
		defaultSeverity: "medium",
		category: "drykiss",
	},
	C1: {
		code: "C1",
		name: "Clarity hit",
		diagnosticQuestion: "Is the code's intent unclear at the point of reading?",
		sources: ["clarity"],
		defaultSeverity: "low",
		category: "drykiss",
	},
	R7: {
		code: "R7",
		name: "Resilience gap",
		diagnosticQuestion:
			"Will the code fail in an unhelpful way under load / partial failure?",
		sources: ["resilience"],
		defaultSeverity: "medium",
		category: "drykiss",
	},
	A1: {
		code: "A1",
		name: "Architecture drift",
		diagnosticQuestion:
			"Does the change violate the project's module boundaries?",
		sources: ["architecture"],
		defaultSeverity: "high",
		category: "drykiss",
	},
	S1: {
		code: "S1",
		name: "Security smell",
		diagnosticQuestion:
			"Could this be exploited, leak data, or weaken an existing control?",
		sources: ["security"],
		defaultSeverity: "high",
		category: "drykiss",
	},
	X1: {
		code: "X1",
		name: "Cross-cutting (synthesis)",
		diagnosticQuestion:
			"Finding produced by synthesis deduplication, not a primary lens.",
		sources: ["synthesis"],
		defaultSeverity: "medium",
		category: "drykiss",
	},
} as const satisfies Record<string, RiskCodeDefinition>;

/** A Set of valid risk codes for O(1) membership checks. */
export const VALID_RISK_CODES: ReadonlySet<string> = new Set(
	Object.keys(RISK_CODES),
);
