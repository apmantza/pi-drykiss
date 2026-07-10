import { describe, expect, it } from "vitest";
import { finalizeReviewOutcome } from "./review-finalizer.js";
import type { Finding } from "./types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/a.ts",
		line: 3,
		severity: "medium",
		category: "Bug",
		summary: "A real issue",
		detail: "This explains the issue.",
		suggestion: "Fix it.",
		...overrides,
	};
}

function finalize(
	overrides: Partial<Parameters<typeof finalizeReviewOutcome>[0]> = {},
) {
	return finalizeReviewOutcome({
		findings: [],
		errors: [],
		validationIssues: [],
		healthScore: 100,
		...overrides,
	});
}

describe("finalizeReviewOutcome", () => {
	it("approves a complete review with no active findings", () => {
		const result = finalize();

		expect(result).toMatchObject({
			reviewStatus: "done",
			codeRisk: "clean",
			verdict: "Approve",
			verdictSource: "deterministic",
			clean: true,
			qualityGate: { status: "pass", threshold: 70, score: 100 },
		});
	});

	it("does not turn a failed review into a code-risk finding", () => {
		const result = finalize({ errors: ["security: model unavailable"] });

		expect(result.reviewStatus).toBe("error");
		expect(result.codeRisk).toBe("clean");
		expect(result.verdict).toBe("Approve");
		expect(result.clean).toBe(false);
		expect(result.qualityGate.status).toBe("fail");
	});

	it("preserves code health while surfacing malformed synthesis as degraded", () => {
		const result = finalize({
			validationIssues: [{ findingIndex: 0, reason: "missing suggestion" }],
		});

		expect(result.reviewStatus).toBe("validation-degraded");
		expect(result.codeRisk).toBe("clean");
		expect(result.clean).toBe(false);
		expect(result.qualityGate.status).toBe("warn");
	});

	it("fails the gate for validation degradation below the health threshold", () => {
		const result = finalize({
			validationIssues: [{ findingIndex: 0, reason: "missing suggestion" }],
			healthScore: 69,
		});

		expect(result.qualityGate).toMatchObject({
			status: "fail",
			reasons: [
				"one or more synthesized findings failed validation",
				"health score is below the configured threshold (70)",
			],
		});
	});

	it("derives request-changes from active blocking findings", () => {
		const result = finalize({
			findings: [finding({ severity: "high" })],
			healthScore: 95,
		});

		expect(result.codeRisk).toBe("request-changes");
		expect(result.verdict).toBe("Request changes");
		expect(result.qualityGate.status).toBe("fail");
	});

	it("fails the gate for blocking findings despite validation degradation", () => {
		const result = finalize({
			findings: [finding({ severity: "high" })],
			validationIssues: [{ findingIndex: 1, reason: "missing suggestion" }],
		});

		expect(result.reviewStatus).toBe("validation-degraded");
		expect(result.codeRisk).toBe("request-changes");
		expect(result.qualityGate).toMatchObject({
			status: "fail",
			reasons: [
				"one or more synthesized findings failed validation",
				"active blocking finding requires changes",
			],
		});
	});

	it("derives security review from a blocking security finding", () => {
		const result = finalize({
			findings: [finding({ severity: "critical", lens: "security" })],
			healthScore: 85,
		});

		expect(result.codeRisk).toBe("security-review");
		expect(result.verdict).toBe("Needs security review");
	});

	it("recognizes security as a plus-separated synthesis source", () => {
		const result = finalize({
			findings: [
				finding({ severity: "high", source: "resilience+security+tests" }),
			],
		});

		expect(result.codeRisk).toBe("security-review");
	});

	it("does not infer security risk from a partial or absent source token", () => {
		const result = finalize({
			findings: [
				finding({ severity: "high", source: "security-review" }),
				finding({ severity: "high", source: undefined }),
			],
		});

		expect(result.codeRisk).toBe("request-changes");
	});

	it("does not infer security risk from a non-blocking source token", () => {
		const result = finalize({
			findings: [finding({ severity: "medium", source: "security" })],
		});

		expect(result.codeRisk).toBe("comments");
	});

	it("does not block on explicitly ignored findings", () => {
		const result = finalize({
			findings: [finding({ severity: "critical", action: "ignore" })],
		});

		expect(result.codeRisk).toBe("clean");
		expect(result.verdict).toBe("Approve");
	});
});
