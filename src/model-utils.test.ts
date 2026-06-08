import { describe, it, expect } from "vitest";
import { findModelByHint } from "./model-utils.js";

function makeModel(
	id: string,
	provider = "anthropic",
	name?: string,
) {
	return { id, provider, name: name ?? id } as any;
}

describe("findModelByHint", () => {
	const available = [
		makeModel("claude-sonnet-4", "anthropic", "Claude Sonnet 4"),
		makeModel("claude-haiku-3", "anthropic", "Claude Haiku 3"),
		makeModel("gpt-4o", "openai", "GPT-4o"),
		makeModel("gpt-4o-mini", "openai", "GPT-4o Mini"),
	];

	it("matches exact provider/id (case-insensitive)", () => {
		const result = findModelByHint(available, "anthropic/claude-sonnet-4");
		expect(result).toBeDefined();
		expect(result!.id).toBe("claude-sonnet-4");
	});

	it("matches exact provider/id with different case", () => {
		const result = findModelByHint(available, "ANTHROPIC/CLAUDE-SONNET-4");
		expect(result).toBeDefined();
		expect(result!.id).toBe("claude-sonnet-4");
	});

	it("matches substring on model id", () => {
		const result = findModelByHint(available, "haiku");
		expect(result).toBeDefined();
		expect(result!.id).toBe("claude-haiku-3");
	});

	it("matches substring on model name", () => {
		const result = findModelByHint(available, "GPT");
		expect(result).toBeDefined();
		expect(result!.id).toBe("gpt-4o");
	});

	it("returns undefined when nothing matches", () => {
		const result = findModelByHint(available, "nonexistent-model");
		expect(result).toBeUndefined();
	});

	it("prefers exact provider/id over substring", () => {
		// "gpt-4o" matches "gpt-4o-mini" as substring too, but exact wins
		const result = findModelByHint(available, "openai/gpt-4o");
		expect(result).toBeDefined();
		expect(result!.id).toBe("gpt-4o");
	});

	it("prefers id match over name match", () => {
		const models = [
			makeModel("sonnet", "anthropic", "Fast Model"),
			makeModel("haiku", "anthropic", "Sonnet"),
		];
		const result = findModelByHint(models, "sonnet");
		expect(result).toBeDefined();
		expect(result!.id).toBe("sonnet"); // id match beats name match
	});

	it("returns undefined for empty available list", () => {
		expect(findModelByHint([], "anything")).toBeUndefined();
	});

	it("returns undefined for empty hint", () => {
		expect(findModelByHint(available, "")).toBeUndefined();
	});
});
