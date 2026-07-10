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

	it("derives request-changes from active blocking findings", () => {
		const result = finalize({
			findings: [finding({ severity: "high" })],
			healthScore: 95,
		});

		expect(result.codeRisk).toBe("request-changes");
		expect(result.verdict).toBe("Request changes");
		expect(result.qualityGate.status).toBe("fail");
	});

	it("derives security review from a blocking security finding", () => {
		const result = finalize({
			findings: [finding({ severity: "critical", lens: "security" })],
			healthScore: 85,
		});

		expect(result.codeRisk).toBe("security-review");
		expect(result.verdict).toBe("Needs security review");
	});

	it("does not block on explicitly ignored findings", () => {
		const result = finalize({
			findings: [finding({ severity: "critical", action: "ignore" })],
		});

		expect(result.codeRisk).toBe("clean");
		expect(result.verdict).toBe("Approve");
	});
});
