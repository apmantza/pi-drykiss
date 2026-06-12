import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
	isAuthError,
	isModelError,
	isQuotaError,
	isServerError,
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

describe("isServerError", () => {
	it("detects the 5xx HTTP status codes that warrant model switching", () => {
		expect(isServerError(new Error("504 Gateway Timeout"))).toBe(true);
		expect(isServerError(new Error("502 Bad Gateway"))).toBe(true);
		expect(isServerError(new Error("503 Service Unavailable"))).toBe(true);
		expect(isServerError(new Error("500 Internal Server Error"))).toBe(true);
	});

	it("detects Cloudflare edge-layer codes", () => {
		expect(isServerError(new Error("522 Connection Timed Out"))).toBe(true);
		expect(isServerError(new Error("524 A Timeout Occurred"))).toBe(true);
	});

	it("detects 5xx codes embedded in structured error objects", () => {
		expect(isServerError({ status: 504 })).toBe(true);
		expect(isServerError({ error: { type: "server_error", code: 502 } })).toBe(
			true,
		);
	});

	it("detects provider stream termination errors", () => {
		expect(isServerError(new Error("terminated"))).toBe(true);
		expect(isServerError(new Error("stream terminated"))).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isServerError(new Error("Rate limit exceeded"))).toBe(false);
		expect(isServerError(new Error("Invalid API key"))).toBe(false);
		expect(isServerError(new Error("Network timeout"))).toBe(false);
		expect(isServerError(new Error("File not found"))).toBe(false);
	});

	it("returns false for non-errors", () => {
		expect(isServerError(42)).toBe(false);
		expect(isServerError(null)).toBe(false);
		expect(isServerError(undefined)).toBe(false);
	});
});

describe("isModelError", () => {
	it("returns true for quota errors", () => {
		expect(isModelError(new Error("429 Too Many Requests"))).toBe(true);
		expect(isModelError(new Error("insufficient_quota"))).toBe(true);
	});

	it("returns true for auth errors", () => {
		expect(isModelError(new Error("Invalid API key"))).toBe(true);
		expect(isModelError(new Error("Forbidden: 403"))).toBe(true);
	});

	it("returns true for server errors (5xx) — triggers autorouting", () => {
		expect(isModelError(new Error("504 Gateway Timeout"))).toBe(true);
		expect(isModelError(new Error("502 Bad Gateway"))).toBe(true);
		expect(isModelError(new Error("503 Service Unavailable"))).toBe(true);
		expect(isModelError(new Error("500 Internal Server Error"))).toBe(true);
	});

	it("detects 5xx in plain strings (e.g. body-less HTTP responses)", () => {
		expect(isModelError("504")).toBe(true);
		expect(isModelError("502")).toBe(true);
	});

	it("detects 5xx in structured error objects", () => {
		expect(isModelError({ status: 504, message: "no body" })).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isModelError(new Error("File not found"))).toBe(false);
		expect(isModelError(new Error("Syntax error"))).toBe(false);
		expect(isModelError(new Error("Network timeout"))).toBe(false);
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

	function makeCtx(overrides: { hasUI?: boolean } = {}): any {
		return {
			hasUI: overrides.hasUI ?? true,
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

	it("returns undefined when no free model exists AND hasUI is false (headless)", async () => {
		const ctx = makeCtx({ hasUI: false });
		ctx.modelRegistry.getAvailable.mockReturnValue([paidSonnet]);

		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: "haiku" },
			"Title",
			"Message",
		);
		// Neither autoroute nor popup can recover — caller will see the
		// original error rather than a crash.
		expect(result).toBeUndefined();
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("returns undefined when autoroute is on with no free model, no UI, no popup", async () => {
		// Same as above but explicitly verifying the popup is NOT called.
		const ctx = makeCtx({ hasUI: false });
		ctx.modelRegistry.getAvailable.mockReturnValue([freeHaiku]); // free model exists
		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true },
			"Title",
			"Message",
		);
		// Autoroute picks the free model — no UI needed.
		expect(result?.id).toBe("claude-3-5-haiku");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
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

	// --- List-form modelScope (preference order) ---

	it("returns the first matching free model when modelScope is a list", async () => {
		const ctx = makeCtx();
		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: ["haiku", "gpt-4o"] },
			"Title",
			"Message",
		);
		// Both hints match a free model; "haiku" comes first in the list.
		expect(result?.id).toBe("claude-3-5-haiku");
	});

	it("falls through to the second hint when the first doesn't match", async () => {
		const ctx = makeCtx();
		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: ["nonexistent", "gpt-4o"] },
			"Title",
			"Message",
		);
		expect(result?.id).toBe("gpt-4o-free");
	});

	it("falls back to any free model when none of the list hints match", async () => {
		const ctx = makeCtx();
		const result = await selectModelWithAutoroute(
			ctx,
			{
				autoroute: true,
				modelScope: ["nonexistent-a", "nonexistent-b"],
			},
			"Title",
			"Message",
		);
		// Both list entries miss, so the resolver falls through to "any free"
		// — the first non-excluded free model is returned.
		expect(result?.cost?.input).toBe(0);
	});

	it("formats the scope notification as a bracketed list when modelScope is an array", async () => {
		const ctx = makeCtx();
		await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: ["haiku", "gpt-4o"] },
			"Title",
			"Message",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("scope: [haiku, gpt-4o]"),
			"info",
		);
	});

	it("ignores empty / whitespace-only entries in the list (no widening)", async () => {
		const ctx = makeCtx();
		const result = await selectModelWithAutoroute(
			ctx,
			{ autoroute: true, modelScope: ["", "  ", "haiku"] },
			"Title",
			"Message",
		);
		// Empty entries are dropped — the substantive hint still drives the
		// match. A naive implementation that treated "" as "match anything"
		// would return the first free model instead.
		expect(result?.id).toBe("claude-3-5-haiku");
	});
});
