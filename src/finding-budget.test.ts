import { describe, expect, it } from "vitest";
import { applyFindingBudget } from "./finding-budget.js";
import type { Finding } from "./types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/a.ts",
		severity: "low",
		category: "Review",
		summary: "Observation",
		detail: "Details",
		suggestion: "Fix it",
		...overrides,
	};
}

describe("applyFindingBudget", () => {
	it("keeps the strongest findings within the total budget", () => {
		const result = applyFindingBudget(
			[
				finding({ severity: "low", summary: "low" }),
				finding({ severity: "high", summary: "high" }),
				finding({ severity: "medium", summary: "medium" }),
			],
			{ maxFindings: 2 },
		);

		expect(result.findings.map((item) => item.summary)).toEqual([
			"high",
			"medium",
		]);
		expect(result.omittedLowPriorityCount).toBe(1);
	});

	it("caps nits independently", () => {
		const result = applyFindingBudget(
			[
				finding({ severity: "nit", summary: "first" }),
				finding({ severity: "nit", summary: "second" }),
			],
			{ maxNits: 1 },
		);

		expect(result.findings).toHaveLength(1);
		expect(result.omittedNitCount).toBe(1);
	});

	it("does not cap critical or validator-confirmed security findings", () => {
		const result = applyFindingBudget(
			[
				finding({ severity: "critical", summary: "critical" }),
				finding({
					severity: "high",
					summary: "security",
					lens: "security",
					_validatorVerdict: "real",
				}),
				finding({ severity: "low", summary: "omitted" }),
			],
			{ maxFindings: 0 },
		);

		expect(result.findings.map((item) => item.summary)).toEqual([
			"critical",
			"security",
		]);
		expect(result.omittedLowPriorityCount).toBe(1);
	});
});
