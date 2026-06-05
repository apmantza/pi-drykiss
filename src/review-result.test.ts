import { describe, expect, it } from "vitest";
import { buildReviewResult, validateFindings } from "./review-result.js";
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
