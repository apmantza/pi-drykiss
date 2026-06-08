import { describe, expect, it } from "vitest";
import {
	buildReviewResult,
	validateFindings,
	applySeverityOverrides,
	filterIgnored,
	applySuppressions,
	isSuppressionExpired,
	getExpiredSuppressionIds,
} from "./review-result.js";
import type { ReviewJob } from "./review-manager.js";
import type { Finding } from "./types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/a.ts",
		line: 3,
		severity: "high",
		category: "Bug",
		summary: "A real issue",
		detail: "This explains the issue.",
		suggestion: "Fix it.",
		...overrides,
	};
}

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
	return {
		id: "job-1",
		files: ["src/a.ts", "src/b.ts"],
		lenses: ["simplicity", "security"],
		states: new Map([
			[
				"simplicity",
				{
					status: "done",
					modelName: "model",
					durationMs: 10,
					findingsCount: 0,
					rawOutput: "[]",
				},
			],
			[
				"security",
				{
					status: "done",
					modelName: "model",
					durationMs: 10,
					findingsCount: 0,
					rawOutput: "[]",
				},
			],
		]),
		synthesisStatus: "done",
		synthesisResult: {
			findings: [],
			summary: "Looks good.",
			verdict: "Approve",
			criticalCount: 0,
			highCount: 0,
			mediumCount: 0,
			lowCount: 0,
			nitCount: 0,
			healthScore: 100,
			scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
		},
		overallStatus: "done",
		startedAt: 1,
		completedAt: 2,
		...overrides,
	};
}

describe("validateFindings", () => {
	it("keeps valid in-scope findings", () => {
		const result = validateFindings([finding()], new Set(["src/a.ts"]));
		expect(result.findings).toHaveLength(1);
		expect(result.issues).toEqual([]);
	});

	it("normalizes Windows separators", () => {
		const result = validateFindings(
			[finding({ file: "src\\a.ts" })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings[0].file).toBe("src/a.ts");
	});

	it("drops unsafe and out-of-scope findings", () => {
		const result = validateFindings(
			[
				finding({ file: "../secret.ts" }),
				finding({ file: "src/not-reviewed.ts" }),
				finding({ summary: "" }),
			],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.issues.map((i) => i.reason)).toEqual([
			"unsafe or missing file path",
			"out-of-scope file: src/not-reviewed.ts",
			"missing summary",
		]);
	});
});

describe("validateFinding — consequence/source (Phase 1)", () => {
	it("rejects a finding with empty-string consequence", () => {
		const result = validateFindings(
			[finding({ consequence: "" })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.issues[0].reason).toBe("empty consequence");
	});

	it("rejects a finding with empty-string source", () => {
		const result = validateFindings(
			[finding({ source: "" })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.issues[0].reason).toBe("empty source");
	});

	it("rejects a finding with non-string consequence", () => {
		const result = validateFindings(
			[finding({ consequence: 42 as unknown as string })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.issues[0].reason).toBe("empty consequence");
	});

	it("accepts a finding with non-empty consequence and source", () => {
		const result = validateFindings(
			[
				finding({
					consequence: "Subsequent calls will fail.",
					source: "UserService.updateProfile",
				}),
			],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(1);
		expect(result.issues).toEqual([]);
	});

	it("accepts a legacy persisted finding with undefined consequence/source", () => {
		// Backward compat: persisted findings from before the contract landed
		// may have these fields absent. Validator must not reject them.
		const result = validateFindings(
			[finding({ consequence: undefined, source: undefined })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(1);
		expect(result.issues).toEqual([]);
	});

	it("trims whitespace before checking emptiness", () => {
		const result = validateFindings(
			[finding({ consequence: "   " })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(0);
		expect(result.issues[0].reason).toBe("empty consequence");
	});
});

describe("validateFinding — riskCode (Phase 1)", () => {
	it("accepts a finding with a riskCode", () => {
		const result = validateFindings(
			[finding({ riskCode: "R1" })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(1);
	});

	it("accepts a finding without a riskCode (Phase 2 will require it)", () => {
		// For now riskCode is optional. Phase 2 introduces the per-lens
		// risk code catalogue and can tighten this if needed.
		const result = validateFindings(
			[finding({ riskCode: undefined })],
			new Set(["src/a.ts"]),
		);
		expect(result.findings).toHaveLength(1);
	});
});

describe("buildReviewResult", () => {
	it("marks approve-with-no-findings as clean", () => {
		const result = buildReviewResult(job({ reviewPath: "/tmp/review.json" }), {
			target: { mode: "local", label: "local changes" },
		});

		expect(result.clean).toBe(true);
		expect(result.status).toBe("done");
		expect(result.verdict).toBe("Approve");
		expect(result.target?.label).toBe("local changes");
		expect(result.reportPath).toBe("/tmp/review.json");
		expect(result.counts.total).toBe(0);
		expect(result.errors).toEqual([]);
	});

	it("counts valid findings and makes the result non-clean", () => {
		const result = buildReviewResult(
			job({
				synthesisResult: {
					findings: [
						finding({ severity: "critical" }),
						finding({ severity: "low", file: "src/b.ts" }),
					],
					summary: "Issues found.",
					verdict: "Request changes",
					criticalCount: 1,
					highCount: 0,
					mediumCount: 0,
					lowCount: 1,
					nitCount: 0,
					healthScore: 84,
					scoreBreakdown: { critical: 1, warning: 0, suggestion: 1 },
				},
			}),
		);

		expect(result.clean).toBe(false);
		expect(result.counts).toMatchObject({ total: 2, critical: 1, low: 1 });
		expect(result.findings).toHaveLength(2);
	});

	it("collects lens and synthesis errors", () => {
		const base = job({
			overallStatus: "error",
			synthesisStatus: "error",
			synthesisResult: {
				findings: [],
				summary: "Synthesis failed: boom",
				verdict: "Request changes",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
			},
		});
		base.states.set("security", {
			status: "error",
			modelName: "model",
			durationMs: 1,
			findingsCount: 0,
			rawOutput: "ERROR",
			errorMessage: "quota",
		});

		const result = buildReviewResult(base);

		expect(result.clean).toBe(false);
		expect(result.errors).toEqual([
			"security: quota",
			"synthesis: Synthesis failed: boom",
		]);
	});
});

describe("applySeverityOverrides — Phase 2", () => {
	it("downgrades severity for matching riskCode", () => {
		const f = finding({ riskCode: "K1", severity: "critical" });
		const result = applySeverityOverrides([f], [{ riskCode: "K1", to: "low" }]);
		expect(result[0].severity).toBe("low");
	});

	it("leaves non-matching findings unchanged", () => {
		const f = finding({ riskCode: "K1", severity: "high" });
		const result = applySeverityOverrides([f], [{ riskCode: "R1", to: "low" }]);
		expect(result[0].severity).toBe("high");
	});

	it("leaves findings without riskCode unchanged", () => {
		const f = finding({ riskCode: undefined, severity: "high" });
		const result = applySeverityOverrides([f], [{ riskCode: "K1", to: "low" }]);
		expect(result[0].severity).toBe("high");
	});

	it("handles empty overrides array", () => {
		const f = finding({ riskCode: "K1", severity: "critical" });
		const result = applySeverityOverrides([f], []);
		expect(result[0].severity).toBe("critical");
	});
});

describe("filterIgnored — Phase 2", () => {
	it("drops findings matching an ignore glob pattern", () => {
		const findings = [
			finding({ file: "src/a.ts" }),
			finding({ file: "src/legacy/old.ts" }),
			finding({ file: "tests/e2e/suite.ts" }),
		];
		const result = filterIgnored(findings, ["src/legacy/**"]);
		expect(result.findings).toHaveLength(2);
		expect(result.dropped).toBe(1);
		expect(result.findings.map((f: Finding) => f.file)).not.toContain(
			"src/legacy/old.ts",
		);
	});

	it("drops findings matching multiple glob patterns", () => {
		const findings = [
			finding({ file: "src/a.ts" }),
			finding({ file: "src/legacy/old.ts" }),
			finding({ file: "tests/e2e/suite.ts" }),
		];
		const result = filterIgnored(findings, ["src/legacy/**", "tests/e2e/**"]);
		expect(result.findings).toHaveLength(1);
		expect(result.dropped).toBe(2);
	});

	it("returns all findings when no patterns are given", () => {
		const findings = [finding({ file: "src/a.ts" })];
		const result = filterIgnored(findings, []);
		expect(result.findings).toHaveLength(1);
		expect(result.dropped).toBe(0);
	});

	it("handles * pattern (single segment)", () => {
		const findings = [
			finding({ file: "src/util.ts" }),
			finding({ file: "src/util/sub.ts" }),
		];
		const result = filterIgnored(findings, ["src/*.ts"]);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].file).toBe("src/util/sub.ts");
	});

	it("accepts findings gracefully with non-matching glob", () => {
		const f = finding({ file: "src/a.ts" });
		const result = filterIgnored([f], ["**/legacy/**"]);
		expect(result.findings).toHaveLength(1);
		expect(result.dropped).toBe(0);
	});

	describe("applySuppressions", () => {
		it("returns all active when no suppressions", () => {
			const f = finding({ file: "src/a.ts", riskCode: "K1" });
			const result = applySuppressions([f], []);
			expect(result.active).toHaveLength(1);
			expect(result.suppressed).toHaveLength(0);
			expect(result.active[0]._suppressed).toBeUndefined();
		});

		it("suppresses finding matching riskCode and glob", () => {
			const findings = [
				finding({
					file: "src/legacy/foo.ts",
					severity: "high",
					riskCode: "K1",
				}),
				finding({
					file: "src/modern/bar.ts",
					severity: "high",
					riskCode: "K1",
				}),
			];
			const result = applySuppressions(findings, [
				{ id: "s1", riskCode: "K1", pattern: "src/legacy/**" },
			]);
			expect(result.active).toHaveLength(1);
			expect(result.active[0].file).toBe("src/modern/bar.ts");
			expect(result.suppressed).toHaveLength(1);
			expect(result.suppressed[0].file).toBe("src/legacy/foo.ts");
			expect(result.suppressed[0].severity).toBe("nit");
			expect(result.suppressed[0]._suppressed).toBe(true);
			expect(result.suppressed[0]._suppressionRef).toBe("s1");
		});

		it("suppresses any risk code with wildcard", () => {
			const findings = [
				finding({ file: "src/foo.ts", severity: "high", riskCode: "K1" }),
				finding({ file: "src/bar.ts", severity: "high", riskCode: "D1" }),
			];
			const result = applySuppressions(findings, [
				{ id: "s1", riskCode: "*", pattern: "src/*.ts" },
			]);
			expect(result.active).toHaveLength(0);
			expect(result.suppressed).toHaveLength(2);
		});

		it("does not suppress non-matching riskCode", () => {
			const f = finding({ file: "src/foo.ts", riskCode: "D1" });
			const result = applySuppressions(
				[f],
				[{ id: "s1", riskCode: "K1", pattern: "src/foo.ts" }],
			);
			expect(result.active).toHaveLength(1);
			expect(result.suppressed).toHaveLength(0);
		});

		it("does not suppress non-matching file pattern", () => {
			const f = finding({ file: "src/other.ts", riskCode: "K1" });
			const result = applySuppressions(
				[f],
				[{ id: "s1", riskCode: "K1", pattern: "src/legacy/**" }],
			);
			expect(result.active).toHaveLength(1);
			expect(result.suppressed).toHaveLength(0);
		});
	});

	describe("isSuppressionExpired", () => {
		it("returns false when no expiresAt", () => {
			expect(isSuppressionExpired({})).toBe(false);
		});

		it("returns false when expiry is in the future", () => {
			const future = new Date();
			future.setFullYear(future.getFullYear() + 1);
			expect(isSuppressionExpired({ expiresAt: future.toISOString() })).toBe(
				false,
			);
		});

		it("returns true when expiry is in the past", () => {
			const past = new Date("2000-01-01");
			expect(isSuppressionExpired({ expiresAt: past.toISOString() })).toBe(
				true,
			);
		});

		it("handles invalid date gracefully", () => {
			expect(isSuppressionExpired({ expiresAt: "not-a-date" })).toBe(false);
		});
	});

	describe("getExpiredSuppressionIds", () => {
		it("returns empty when no suppressions expired", () => {
			const result = getExpiredSuppressionIds([
				{ id: "s1" },
				{ id: "s2", expiresAt: "2099-01-01" },
			]);
			expect(result).toEqual([]);
		});

		it("returns ids of expired suppressions", () => {
			const result = getExpiredSuppressionIds([
				{ id: "s1", expiresAt: "2000-01-01" },
				{ id: "s2" },
				{ id: "s3", expiresAt: "2099-01-01" },
			]);
			expect(result).toEqual(["s1"]);
		});
	});
});

describe("buildReviewResult — mermaidGraph", () => {
	it("includes mermaidGraph from synthesisResult", () => {
		const myJob = job({
			synthesisResult: {
				findings: [],
				summary: "ok",
				verdict: "Approve",
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				nitCount: 0,
				healthScore: 100,
				scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
				mermaidGraph: "graph TD\n  A[a.ts]\n  B[b.ts]",
			},
		});
		const result = buildReviewResult(myJob);
		expect(result.mermaidGraph).toBe("graph TD\n  A[a.ts]\n  B[b.ts]");
	});

	it("omits mermaidGraph when synthesisResult has none", () => {
		const result = buildReviewResult(job());
		expect(result.mermaidGraph).toBeUndefined();
	});
});
