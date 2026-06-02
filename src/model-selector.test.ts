import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
	isQuotaError,
	isAuthError,
	selectModelWithAutoroute,
} from "./model-selector.js";
import * as freeModels from "./free-models.js";

function mockModel(
	provider: string,
	id: string,
	name: string,
	cost?: { input: number; output: number },
): Model<Api> {
	return {
		provider,
		id,
		name,
		cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

describe("isQuotaError", () => {
	it("detects rate limit errors", () => {
		expect(isQuotaError(new Error("Rate limit exceeded"))).toBe(true);
		expect(isQuotaError(new Error("429 Too Many Requests"))).toBe(true);
		expect(isQuotaError(new Error("insufficient_quota"))).toBe(true);
		expect(isQuotaError(new Error("API is overloaded"))).toBe(true);
	});

	it("detects insufficient balance/budget errors", () => {
		expect(isQuotaError(new Error("Insufficient balance"))).toBe(true);
		expect(isQuotaError(new Error("insufficient credits"))).toBe(true);
		expect(isQuotaError(new Error("Budget exceeded"))).toBe(true);
		expect(isQuotaError(new Error("Usage limit exceeded"))).toBe(true);
	});

	it("detects quota keywords", () => {
		expect(isQuotaError(new Error("You have exceeded your QUOTA"))).toBe(true);
		expect(isQuotaError(new Error("Capacity reached"))).toBe(true);
	});

	it("detects payment/billing errors", () => {
		expect(isQuotaError(new Error("402 Payment Required"))).toBe(true);
		expect(isQuotaError(new Error("Payment required"))).toBe(true);
		expect(isQuotaError(new Error("out of credits"))).toBe(true);
	});

	it("detects inference/streaming failures", () => {
		expect(
			isQuotaError(
				new Error("Failed to create stream: inference request failed"),
			),
		).toBe(true);
		expect(isQuotaError(new Error("inference error"))).toBe(true);
		expect(isQuotaError(new Error("Request failed"))).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isQuotaError(new Error("Network timeout"))).toBe(false);
		expect(isQuotaError(new Error("File not found"))).toBe(false);
		expect(isQuotaError(new Error("Syntax error"))).toBe(false);
	});

	it("returns false for non-errors", () => {
		expect(isQuotaError(42)).toBe(false);
		expect(isQuotaError(null)).toBe(false);
		expect(isQuotaError(undefined)).toBe(false);
	});

	it("detects quota keywords in plain strings", () => {
		expect(isQuotaError("402 Payment Required")).toBe(true);
		expect(isQuotaError("Rate limit exceeded")).toBe(true);
		expect(isQuotaError("insufficient_quota")).toBe(true);
		expect(isQuotaError("Budget exceeded")).toBe(true);
	});
});

describe("isAuthError", () => {
	it("detects API key errors", () => {
		expect(isAuthError(new Error("Invalid API key"))).toBe(true);
		expect(isAuthError(new Error("Authentication failed"))).toBe(true);
		expect(isAuthError(new Error("Unauthorized: 401"))).toBe(true);
		expect(isAuthError(new Error("Forbidden: 403"))).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isAuthError(new Error("Network timeout"))).toBe(false);
		expect(isAuthError(new Error("Rate limit"))).toBe(false);
	});

	it("detects auth keywords in plain strings", () => {
		expect(isAuthError("Invalid API key")).toBe(true);
		expect(isAuthError("Unauthorized: 401")).toBe(true);
		expect(isAuthError("Forbidden: 403")).toBe(true);
	});
});

describe("selectModelWithAutoroute", () => {
	const freeHaiku = mockModel("anthropic", "claude-3-5-haiku", "Haiku (free)", {
		input: 0,
		output: 0,
	});
	const freeOpenai = mockModel("openai", "gpt-4o-free", "GPT-4o Free", {
		input: 0,
		output: 0,
	});
	const paidSonnet = mockModel("anthropic", "claude-sonnet-4", "Sonnet 4", {
		input: 3,
		output: 15,
	});

	function makeCtx(): any {
		return {
			modelRegistry: {
				getAvailable: vi
					.fn()
					.mockReturnValue([paidSonnet, freeHaiku, freeOpenai]),
				find: vi.fn().mockImplementation((p: string, id: string) => {
					const all = [paidSonnet, freeHaiku, freeOpenai];
					return all.find((m) => m.provider === p && m.id === id);
				}),
			},
			ui: {
				notify: vi.fn(),
				// Stub the popup's custom renderer so the fallback path can be
				// exercised in tests without rendering a real SelectList.
				custom: vi
					.fn()
					.mockResolvedValue(`${paidSonnet.provider}/${paidSonnet.id}`),
			},
		};
	}

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a free model when autoroute is on and a free model matches the scope", async () => {
		const ctx = makeCtx();
		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: "haiku" },
			"Title",
			"Message",
		);
		expect(result?.id).toBe("claude-3-5-haiku");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Auto-routing to Haiku"),
			"info",
		);
	});

	it("returns any free model when autoroute is on and no scope is set", async () => {
		const ctx = makeCtx();
		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true },
			"Title",
			"Message",
		);
		expect(result).toBeDefined();
		expect(result?.cost?.input).toBe(0);
	});

	it("falls back to any free model when scope is set but no match exists", async () => {
		const ctx = makeCtx();
		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: "nonexistent" },
			"Title",
			"Message",
		);
		expect(result).toBeDefined();
		expect(result?.cost?.input).toBe(0);
	});

	it("includes the scope in the notification when scope is set", async () => {
		const ctx = makeCtx();
		await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: "haiku" },
			"Title",
			"Message",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("scope: haiku"),
			"info",
		);
	});

	it("omits the scope from the notification when scope is not set", async () => {
		const ctx = makeCtx();
		await selectModelWithAutoroute(
			ctx,
			{ autoroute: true },
			"Title",
			"Message",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.not.stringContaining("scope:"),
			"info",
		);
	});

	it("falls through to the popup when autoroute is false", async () => {
		const ctx = makeCtx();
		const spy = vi.spyOn(freeModels, "selectFreeModel");

		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: false },
			"Title",
			"Message",
		);
		// Autoroute was off — the free-model resolver must not be consulted.
		expect(spy).not.toHaveBeenCalled();
		// Popup ran and returned the paid model via the stubbed ui.custom.
		expect(ctx.ui.custom).toHaveBeenCalled();
		expect(result?.id).toBe("claude-sonnet-4");
	});

	it("falls through to the popup when autoroute is on but no free model exists", async () => {
		const ctx = makeCtx();
		ctx.modelRegistry.getAvailable.mockReturnValue([paidSonnet]);

		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: "haiku" },
			"Title",
			"Message",
		);
		// No free model to pick — popup runs.
		expect(ctx.ui.custom).toHaveBeenCalled();
		expect(result?.id).toBe("claude-sonnet-4");
	});

	it("forwards the excluded model to the free-model resolver", async () => {
		const ctx = makeCtx();
		const spy = vi.spyOn(freeModels, "selectFreeModel");
		await selectModelWithAutoroute(
			ctx,
			{ autoroute: true },
			"Title",
			"Message",
			{ provider: "anthropic", id: "claude-3-5-haiku" },
		);
		expect(spy).toHaveBeenCalledWith(
			ctx,
			undefined,
			expect.objectContaining({
				provider: "anthropic",
				id: "claude-3-5-haiku",
			}),
		);
	});
});
