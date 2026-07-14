import { describe, expect, it } from "vitest";
import { tokenUsageDetails } from "./logger.js";

describe("tokenUsageDetails", () => {
	it("returns the token and total cost fields used by lifecycle logs", () => {
		expect(
			tokenUsageDetails({
				input: 1200,
				output: 300,
				cacheRead: 900,
				cacheWrite: 100,
				totalTokens: 2500,
				cost: {
					input: 0.01,
					output: 0.02,
					cacheRead: 0.001,
					cacheWrite: 0.002,
					total: 0.033,
				},
			}),
		).toEqual({
			inputTokens: 1200,
			outputTokens: 300,
			cacheReadTokens: 900,
			cacheWriteTokens: 100,
			totalTokens: 2500,
			costTotal: 0.033,
		});
	});

	it("omits usage fields when no provider usage is available", () => {
		expect(tokenUsageDetails(undefined)).toBeUndefined();
	});
});
