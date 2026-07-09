import { describe, expect, it } from "vitest";
import {
	bucketFindings,
	bucketToFinding,
	clusterAndFlatten,
	formatBucketsForPrompt,
} from "./bucketing.js";
import type { Finding } from "./types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/a.ts",
		line: 10,
		severity: "medium",
		category: "DRY",
		summary: "Duplicated parsing logic across two modules",
		detail: "x",
		suggestion: "x",
		...overrides,
	};
}

describe("bucketFindings", () => {
	it("returns empty array for empty input", () => {
		expect(bucketFindings([])).toEqual([]);
	});

	it("creates one bucket per finding when nothing is similar", () => {
		// Distinct summaries with minimal token overlap to defeat Jaccard.
		// Give each a distinct lens so each bucket's `votes` is 1.
		const findings = [
			finding({
				file: "a.ts",
				line: 1,
				summary: "Alpha bug in module",
				lens: "simplicity",
			}),
			finding({
				file: "b.ts",
				line: 1,
				summary: "Beta bug elsewhere",
				lens: "deduplication",
			}),
		];
		const buckets = bucketFindings(findings);
		expect(buckets).toHaveLength(2);
		expect(buckets[0].votes).toBe(1);
		expect(buckets[1].votes).toBe(1);
	});

	it("merges two findings in the same file at co-located lines with similar text", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				summary: "Duplicated parsing logic across two modules",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 12,
				summary: "Duplicated parsing logic across three modules",
				lens: "deduplication",
			}),
		];
		const buckets = bucketFindings(findings);
		expect(buckets).toHaveLength(1);
		expect(buckets[0].votes).toBe(2);
		expect(buckets[0].contributingLenses).toEqual([
			"deduplication",
			"simplicity",
		]);
		expect(buckets[0].members).toHaveLength(2);
	});

	it("does NOT merge findings in different files even with identical text", () => {
		const findings = [
			finding({ file: "a.ts", line: 1, summary: "Null check missing" }),
			finding({ file: "b.ts", line: 1, summary: "Null check missing" }),
		];
		const buckets = bucketFindings(findings);
		expect(buckets).toHaveLength(2);
	});

	it("does NOT merge findings on the same file but far-apart lines", () => {
		const findings = [
			finding({ file: "a.ts", line: 10, summary: "Null check missing" }),
			finding({ file: "a.ts", line: 500, summary: "Null check missing" }),
		];
		const buckets = bucketFindings(findings);
		// Line distance is 490, well past the 3-line window.
		expect(buckets).toHaveLength(2);
	});

	it("counts DISTINCT lenses, not duplicate flags from one lens", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				summary: "Duplicated parsing logic across two modules",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 11,
				summary: "Duplicated parsing logic across two modules",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 12,
				summary: "Duplicated parsing logic across two modules",
				lens: "deduplication",
			}),
		];
		const buckets = bucketFindings(findings);
		expect(buckets).toHaveLength(1);
		// Only 2 distinct lenses contributed, not 3 flags.
		expect(buckets[0].votes).toBe(2);
		expect(buckets[0].members).toHaveLength(3);
	});

	it("treats findings without a lens as unique (no self-merge across runs)", () => {
		// Two lens-less findings with very different summaries should
		// not merge — we don't know they're from the same source, so
		// we treat them as independent observations for confidence.
		// The test below uses summaries that share *no* meaningful
		// tokens, so even the Jaccard heuristic wouldn't merge them.
		const findings = [
			finding({
				file: "a.ts",
				line: 1,
				summary: "Alpha issue here",
				lens: undefined,
			}),
			finding({
				file: "a.ts",
				line: 100,
				summary: "Beta issue somewhere",
				lens: undefined,
			}),
		];
		const buckets = bucketFindings(findings);
		expect(buckets).toHaveLength(2);
	});

	it("picks the highest-severity finding as the bucket representative", () => {
		const findings = [
			finding({ file: "a.ts", line: 10, severity: "low", summary: "Issue A" }),
			finding({
				file: "a.ts",
				line: 11,
				severity: "critical",
				summary: "Issue B",
			}),
			finding({
				file: "a.ts",
				line: 12,
				severity: "medium",
				summary: "Issue C",
			}),
		];
		const buckets = bucketFindings(findings);
		expect(buckets[0].representative.severity).toBe("critical");
	});

	it("carries a member's line when the highest-severity representative has none", () => {
		// Regression guard for bucketToFinding's `bucket.line ?? representative.line`
		// fallback: the representative is chosen by severity, but when that finding
		// has no line, the merged result must still surface the bucket's aggregated
		// line from a co-located member. Distinct lenses push votes > 1 so the
		// multi-member (bucketToFinding) path is exercised.
		const findings = [
			finding({
				file: "a.ts",
				line: undefined,
				severity: "critical",
				lens: "simplicity",
				summary: "Duplicate parsing logic across two modules",
			}),
			finding({
				file: "a.ts",
				line: 11,
				severity: "low",
				lens: "clarity",
				summary: "Duplicate parsing logic across two modules",
			}),
		];
		const result = clusterAndFlatten(findings);
		expect(result).toHaveLength(1);
		expect(result[0].severity).toBe("critical");
		expect(result[0].line).toBe(11);
	});

	it("breaks severity ties with longer message length", () => {
		// Both findings need to cluster (same file, co-located line,
		// ≥25% Jaccard) for the tiebreak to be exercised. Use
		// paraphrased text that shares a strong "duplicate logic" core.
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				severity: "high",
				summary: "Duplicate logic short",
			}),
			finding({
				file: "a.ts",
				line: 11,
				severity: "high",
				summary:
					"Duplicate logic is a much longer and more detailed message here",
			}),
		];
		const buckets = bucketFindings(findings);
		expect(buckets).toHaveLength(1);
		expect(buckets[0].representative.summary).toBe(
			"Duplicate logic is a much longer and more detailed message here",
		);
	});

	it("preserves all members (never drops a finding)", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				summary: "Duplicated parsing logic across two modules",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 11,
				summary: "Duplicated parsing logic across two modules",
				lens: "deduplication",
			}),
			finding({ file: "b.ts", line: 1, summary: "Different bug" }),
		];
		const buckets = bucketFindings(findings);
		const totalMembers = buckets.reduce((sum, b) => sum + b.members.length, 0);
		expect(totalMembers).toBe(3);
	});

	it("sorts contributingLenses alphabetically for determinism", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				summary: "Duplicated parsing logic",
				lens: "tests",
			}),
			finding({
				file: "a.ts",
				line: 11,
				summary: "Duplicated parsing logic",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 12,
				summary: "Duplicated parsing logic",
				lens: "architecture",
			}),
		];
		const buckets = bucketFindings(findings);
		expect(buckets[0].contributingLenses).toEqual([
			"architecture",
			"simplicity",
			"tests",
		]);
	});

	it("tightens the bucket line toward a defined value (line is set if any member has one)", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: undefined,
				summary: "First parsing issue",
			}),
			finding({ file: "a.ts", line: 42, summary: "Second parsing issue" }),
		];
		const buckets = bucketFindings(findings);
		expect(buckets).toHaveLength(1);
		expect(buckets[0].line).toBe(42);
	});
});

describe("bucketToFinding", () => {
	it("spreads the representative and adds bucket metadata", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				summary: "Duplicated parsing logic",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 11,
				summary: "Duplicated parsing logic",
				lens: "deduplication",
			}),
		];
		const bucket = bucketFindings(findings)[0];
		const f = bucketToFinding(bucket);
		expect(f._bucketVotes).toBe(2);
		expect(f._bucketLenses).toEqual(["deduplication", "simplicity"]);
		expect(f.file).toBe("a.ts");
	});

	it("preserves the original finding fields (severity, summary, etc.)", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				severity: "high",
				summary: "A real issue",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 11,
				severity: "high",
				summary: "A real issue",
				lens: "deduplication",
			}),
		];
		const bucket = bucketFindings(findings)[0];
		const f = bucketToFinding(bucket);
		expect(f.severity).toBe("high");
		expect(f.summary).toBe("A real issue");
		expect(f._bucketVotes).toBe(2);
	});
});

describe("clusterAndFlatten", () => {
	it("returns empty for empty input", () => {
		expect(clusterAndFlatten([])).toEqual([]);
	});

	it("annotates singletons with _bucketVotes: 1 and empty _bucketLenses", () => {
		const findings = [
			finding({ file: "a.ts", line: 1, summary: "Lonely bug" }),
		];
		const out = clusterAndFlatten(findings);
		expect(out).toHaveLength(1);
		expect(out[0]._bucketVotes).toBe(1);
		expect(out[0]._bucketLenses).toEqual([]);
	});

	it("preserves the input count (no findings dropped)", () => {
		const findings = [
			finding({
				file: "a.ts",
				line: 10,
				summary: "Duplicated parsing logic",
				lens: "simplicity",
			}),
			finding({
				file: "a.ts",
				line: 11,
				summary: "Duplicated parsing logic",
				lens: "deduplication",
			}),
			finding({ file: "b.ts", line: 1, summary: "Different issue" }),
		];
		const out = clusterAndFlatten(findings);
		// Two buckets: 1 cluster of 2 + 1 singleton = 2 findings out.
		expect(out).toHaveLength(2);
	});
});

describe("formatBucketsForPrompt", () => {
	it("returns empty string for empty input", () => {
		expect(formatBucketsForPrompt([])).toBe("");
	});

	it("formats each finding as a numbered block with severity, location, and vote count", () => {
		const findings = [
			{
				...finding({
					file: "src/a.ts",
					line: 42,
					severity: "high",
					summary: "Bug here",
				}),
				_bucketVotes: 1,
			},
		];
		const formatted = formatBucketsForPrompt(findings);
		expect(formatted).toContain("[0] (high) src/a.ts:42");
		expect(formatted).toContain("Bug here");
		expect(formatted).not.toContain("votes");
	});

	it("appends vote count and contributing lenses for multi-lens buckets", () => {
		const findings = [
			{
				...finding({
					file: "src/a.ts",
					line: 42,
					severity: "high",
					summary: "Bug here",
				}),
				_bucketVotes: 3,
				_bucketLenses: [
					"clarity",
					"deduplication",
					"simplicity",
				] as Finding["_bucketLenses"],
			},
		];
		const formatted = formatBucketsForPrompt(findings);
		expect(formatted).toContain("(3 votes");
		expect(formatted).toContain("lenses=clarity+deduplication+simplicity");
	});

	it("strips control characters from summaries to limit prompt-injection surface", () => {
		const findings = [
			{
				...finding({
					file: "src/a.ts",
					line: 42,
					severity: "high",
					summary: "Bug\x00here\x01with\x07bells",
				}),
				_bucketVotes: 1,
			},
		];
		const formatted = formatBucketsForPrompt(findings);
		expect(formatted).toContain("Bugherewithbells");
		expect(formatted).not.toContain("\x00");
		expect(formatted).not.toContain("\x01");
		expect(formatted).not.toContain("\x07");
	});

	it("truncates very long summaries", () => {
		const summary = "x".repeat(600);
		const findings = [
			{
				...finding({
					file: "src/a.ts",
					line: 42,
					severity: "high",
					summary,
				}),
				_bucketVotes: 1,
			},
		];
		const formatted = formatBucketsForPrompt(findings);
		const summaryPortion = formatted.split("\n    ").pop() ?? "";
		expect(summaryPortion.length).toBeLessThanOrEqual(500);
	});
});
