import { describe, it, expect } from "vitest";
import { findModelByHint } from "./llm.js";
import type { Model, Api } from "@earendil-works/pi-ai";

function mockModel(provider: string, id: string, name: string): Model<Api> {
	return { provider, id, name } as Model<Api>;
}

describe("findModelByHint", () => {
	const models = [
		mockModel("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4"),
		mockModel("anthropic", "claude-haiku-35-20241022", "Claude Haiku 3.5"),
		mockModel("openai", "gpt-4o", "GPT-4o"),
		mockModel("openai", "gpt-4o-mini", "GPT-4o Mini"),
	];

	it("matches exact provider/id", () => {
		const result = findModelByHint(
			models,
			"anthropic/claude-sonnet-4-20250514",
		);
		expect(result?.id).toBe("claude-sonnet-4-20250514");
	});

	it("matches exact provider/id case-insensitive", () => {
		const result = findModelByHint(
			models,
			"Anthropic/Claude-Sonnet-4-20250514",
		);
		expect(result?.id).toBe("claude-sonnet-4-20250514");
	});

	it("matches partial id", () => {
		const result = findModelByHint(models, "haiku");
		expect(result?.id).toBe("claude-haiku-35-20241022");
	});

	it("matches partial id case-insensitive", () => {
		const result = findModelByHint(models, "GPT-4O");
		expect(result?.id).toBe("gpt-4o");
	});

	it("matches partial name", () => {
		const result = findModelByHint(models, "sonnet");
		expect(result?.name).toBe("Claude Sonnet 4");
	});

	it("matches partial name case-insensitive", () => {
		const result = findModelByHint(models, "GPT");
		expect(result?.id).toBe("gpt-4o");
	});

	it("returns undefined for no match", () => {
		const result = findModelByHint(models, "nonexistent-model-xyz");
		expect(result).toBeUndefined();
	});

	it("returns undefined for empty list", () => {
		const result = findModelByHint([], "claude");
		expect(result).toBeUndefined();
	});

	it("prefers exact match over partial", () => {
		const result = findModelByHint(models, "gpt-4o");
		// Should match exact id "gpt-4o" not "gpt-4o-mini"
		expect(result?.id).toBe("gpt-4o");
	});

	it("prefers id match over name match", () => {
		const result = findModelByHint(models, "mini");
		// id contains "mini" in gpt-4o-mini
		expect(result?.id).toBe("gpt-4o-mini");
	});
});
