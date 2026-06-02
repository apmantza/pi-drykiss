import { describe, it, expect, vi } from "vitest";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isFreeModel,
	getFreeModels,
	selectFreeModel,
	type FreeModelShape,
} from "./free-models.js";

/** Helper: build a model with a cost field. */
function m(
	provider: string,
	id: string,
	name: string,
	cost?: { input: number; output: number },
): Model<Api> {
	return {
		provider,
		id,
		name,
		api: "openai-completions" as any,
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	} as Model<Api>;
}

function shape(
	provider: string,
	id: string,
	name: string,
	cost?: { input: number; output: number },
): FreeModelShape {
	return { provider, id, name, cost };
}

// =============================================================================
// isFreeModel
// =============================================================================

describe("isFreeModel", () => {
	describe("Route A (pricing exposed)", () => {
		const peers = [
			shape("p", "paid-1", "Paid 1", { input: 1, output: 2 }),
			shape("p", "free-1", "Free 1", { input: 0, output: 0 }),
		];

		it("returns true for zero-cost model when peers expose pricing", () => {
			expect(isFreeModel(peers[1], peers)).toBe(true);
		});

		it("returns false for non-zero-cost model when peers expose pricing", () => {
			expect(isFreeModel(peers[0], peers)).toBe(false);
		});

		it("returns true for model whose name contains 'free' even if cost is non-zero", () => {
			const trial = shape("p", "trial", "Trial (free)", { input: 1, output: 1 });
			expect(isFreeModel(trial, peers)).toBe(true);
		});

		it("returns true for zero-cost model with no peers provided (back-compat)", () => {
			expect(isFreeModel(peers[1])).toBe(true);
		});

		it("returns false for non-zero-cost model with no peers provided (back-compat)", () => {
			expect(isFreeModel(peers[0])).toBe(false);
		});
	});

	describe("Route B (pricing not exposed)", () => {
		// All peers default to cost=0 — the provider didn't expose real pricing.
		const peers = [
			shape("p", "a", "Alpha", { input: 0, output: 0 }),
			shape("p", "b", "Bravo", { input: 0, output: 0 }),
		];

		it("returns true only when name contains 'free'", () => {
			const freeModel = shape("p", "x", "Some Free Model", { input: 0, output: 0 });
			const paidModel = shape("p", "y", "Pro Model", { input: 0, output: 0 });
			expect(isFreeModel(freeModel, peers)).toBe(true);
			expect(isFreeModel(paidModel, peers)).toBe(false);
		});

		it("is case-insensitive on the 'free' substring", () => {
			const f = shape("p", "x", "FREE Tier", { input: 0, output: 0 });
			expect(isFreeModel(f, peers)).toBe(true);
		});
	});

	describe("empty peer lists", () => {
		it("falls back to trusting cost when peers array is empty", () => {
			expect(
				isFreeModel(shape("p", "a", "Alpha", { input: 0, output: 0 }), []),
			).toBe(true);
			expect(
				isFreeModel(shape("p", "a", "Alpha", { input: 1, output: 0 }), []),
			).toBe(false);
		});
	});
});

// =============================================================================
// getFreeModels
// =============================================================================

describe("getFreeModels", () => {
	it("groups by provider and filters to free models", () => {
		const models: FreeModelShape[] = [
			// Provider A exposes pricing
			shape("a", "paid-a", "Paid A", { input: 1, output: 2 }),
			shape("a", "free-a", "Free A", { input: 0, output: 0 }),
			// Provider B doesn't expose pricing (all zero)
			shape("b", "alpha", "Alpha", { input: 0, output: 0 }),
			shape("b", "bravo", "Bravo Free", { input: 0, output: 0 }),
			shape("b", "charlie", "Charlie", { input: 0, output: 0 }),
		];
		const free = getFreeModels(models);
		const ids = free.map((m) => m.id).sort();
		expect(ids).toEqual(["bravo", "free-a"]);
	});

	it("returns empty array when no free models exist", () => {
		const models: FreeModelShape[] = [
			shape("a", "paid-a", "Paid A", { input: 1, output: 2 }),
			shape("a", "paid-b", "Paid B", { input: 5, output: 5 }),
		];
		expect(getFreeModels(models)).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(getFreeModels([])).toEqual([]);
	});
});

// =============================================================================
// selectFreeModel
// =============================================================================

function makeCtx(available: Model<Api>[]): ExtensionContext {
	return {
		modelRegistry: {
			getAvailable: vi.fn().mockReturnValue(available),
		},
	} as unknown as ExtensionContext;
}

describe("selectFreeModel", () => {
	const paidAnthropic = m("anthropic", "claude-sonnet-4", "Claude Sonnet 4", {
		input: 3,
		output: 15,
	});
	const freeHaiku = m("anthropic", "claude-3-5-haiku", "Claude 3.5 Haiku (free)", {
		input: 0,
		output: 0,
	});
	const freeSonnet = m("anthropic", "claude-sonnet-free", "Sonnet Free Tier", {
		input: 0,
		output: 0,
	});
	const freeOpenai = m("openai", "gpt-4o-free", "GPT-4o Free", {
		input: 0,
		output: 0,
	});

	it("returns undefined when no models are available", () => {
		const ctx = makeCtx([]);
		expect(selectFreeModel(ctx)).toBeUndefined();
	});

	it("returns undefined when no free models exist", () => {
		const ctx = makeCtx([paidAnthropic]);
		expect(selectFreeModel(ctx)).toBeUndefined();
	});

	it("returns a free model when no scope is provided", () => {
		const ctx = makeCtx([paidAnthropic, freeHaiku, freeOpenai]);
		const result = selectFreeModel(ctx);
		expect(result).toBeDefined();
		expect(result?.cost?.input).toBe(0);
		expect(result?.cost?.output).toBe(0);
	});

	it("prefers a scope-matching free model when scope is set", () => {
		const ctx = makeCtx([paidAnthropic, freeSonnet, freeHaiku, freeOpenai]);
		const result = selectFreeModel(ctx, "haiku");
		expect(result?.id).toBe("claude-3-5-haiku");
	});

	it("falls back to any free model when no scope match is found", () => {
		const ctx = makeCtx([paidAnthropic, freeSonnet, freeOpenai]);
		const result = selectFreeModel(ctx, "haiku");
		// No haiku present, so we should still get *some* free model
		expect(result).toBeDefined();
		expect(result?.cost?.input).toBe(0);
	});

	it("excludes a model that just failed (matched by provider+id)", () => {
		const ctx = makeCtx([paidAnthropic, freeHaiku, freeOpenai]);
		const result = selectFreeModel(ctx, undefined, {
			provider: "anthropic",
			id: "claude-3-5-haiku",
		});
		// The only remaining free model is the OpenAI one
		expect(result?.provider).toBe("openai");
	});

	it("excludes a model even when it would have been the scope match", () => {
		const ctx = makeCtx([paidAnthropic, freeHaiku, freeOpenai]);
		const result = selectFreeModel(ctx, "haiku", {
			provider: "anthropic",
			id: "claude-3-5-haiku",
		});
		// haiku was excluded by the failed-model filter; fall back to any other free
		expect(result).toBeDefined();
		expect(result?.id).not.toBe("claude-3-5-haiku");
	});

	it("returns a model (the original free list) when ALL free models are excluded", () => {
		// Edge case: only one free model exists and it just failed.
		// Returning undefined would force the popup; returning the same model
		// would loop. We return the original free list as a defensive fallback
		// so the caller at least gets *some* signal and the popup can surface
		// the situation.
		const ctx = makeCtx([freeHaiku]);
		const result = selectFreeModel(ctx, undefined, {
			provider: "anthropic",
			id: "claude-3-5-haiku",
		});
		expect(result?.id).toBe("claude-3-5-haiku");
	});

	it("treats scope as case-insensitive (delegated to findModelByHint)", () => {
		const ctx = makeCtx([paidAnthropic, freeHaiku]);
		const result = selectFreeModel(ctx, "HAIKU");
		expect(result?.id).toBe("claude-3-5-haiku");
	});

	it("ignores an empty / whitespace-only scope", () => {
		const ctx = makeCtx([paidAnthropic, freeHaiku]);
		const result = selectFreeModel(ctx, "   ");
		expect(result).toBeDefined();
	});
});
