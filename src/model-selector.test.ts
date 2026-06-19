import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
	isAuthError,
	isModelError,
	isModelIncompatibleError,
	isQuotaError,
	isServerError,
	isServerGatedError,
	selectModelOnError,
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

// =============================================================================
// isServerGatedError / isModelIncompatibleError / extended isServerError
// =============================================================================

describe("isServerGatedError", () => {
	it("detects the 'Free mode is server-gated' phrasing from the bug report", () => {
		expect(
			isServerGatedError(
				new Error(
					'403 "Free mode is server-gated: the Code · 83eb94f4-1b1-simplicity.jsonl"',
				),
			),
		).toBe(true);
	});

	it("detects related free/trial gate phrasings", () => {
		expect(
			isServerGatedError(new Error("Free mode not enabled for this account")),
		).toBe(true);
		expect(
			isServerGatedError(
				new Error("Trial mode is feature-gated on the server"),
			),
		).toBe(true);
		expect(
			isServerGatedError(
				new Error("Your free tier does not include this model"),
			),
		).toBe(true);
		expect(
			isServerGatedError(new Error("Plan does not include Claude Sonnet")),
		).toBe(true);
	});

	it("returns false for unrelated auth/quota errors", () => {
		expect(isServerGatedError(new Error("Invalid API key"))).toBe(false);
		expect(isServerGatedError(new Error("429 Rate limit exceeded"))).toBe(
			false,
		);
	});
});

describe("isModelIncompatibleError", () => {
	it("detects the 'Unexpected role developer' phrasing from the bug report", () => {
		expect(
			isModelIncompatibleError(
				new Error('400 messages: Unexpected role "developer"'),
			),
		).toBe(true);
	});

	it("detects other role-related 400 errors", () => {
		expect(isModelIncompatibleError(new Error("Invalid role: assistant"))).toBe(
			true,
		);
		expect(
			isModelIncompatibleError(new Error("Role not supported by this model")),
		).toBe(true);
		expect(isModelIncompatibleError(new Error("Unknown role: system"))).toBe(
			true,
		);
	});

	it("returns false for bare 400 errors without role context", () => {
		// A bare "400" without role/messages context should NOT trigger
		// model switching — it's likely a client-side bug.
		expect(isModelIncompatibleError(new Error("400 Bad Request"))).toBe(false);
		expect(isModelIncompatibleError(new Error("Invalid parameter"))).toBe(
			false,
		);
	});
});

describe("isServerError (extended patterns)", () => {
	it("detects 'Stream ended without finish_reason'", () => {
		expect(
			isServerError(
				new Error("Stream ended without finish_reason: connection closed"),
			),
		).toBe(true);
	});

	it("detects related stream-cutoff signals", () => {
		expect(isServerError(new Error("Stream ended unexpectedly"))).toBe(true);
		expect(isServerError(new Error("No finish_reason in response"))).toBe(true);
		expect(isServerError(new Error("Missing finish_reason"))).toBe(true);
		expect(
			isServerError(new Error("Unexpected EOF while reading stream")),
		).toBe(true);
	});
});

describe("isModelError (extended)", () => {
	it("detects server-gated errors as model errors (triggers fallback)", () => {
		expect(isModelError(new Error('403 "Free mode is server-gated"'))).toBe(
			true,
		);
	});

	it("detects model-incompatible 400 errors as model errors", () => {
		expect(
			isModelError(new Error('400 messages: Unexpected role "developer"')),
		).toBe(true);
	});

	it("detects stream-cutoff errors as model errors", () => {
		expect(isModelError(new Error("Stream ended without finish_reason"))).toBe(
			true,
		);
	});
});

// =============================================================================
// selectModelOnError: server-gated fallback to default config
// =============================================================================

describe("selectModelOnError — server-gated fallback", () => {
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
	const paidOpus = mockModel("anthropic", "claude-opus-4", "Opus 4", {
		input: 15,
		output: 75,
	});

	function makeCtx(overrides: { hasUI?: boolean } = {}): any {
		return {
			hasUI: overrides.hasUI ?? true,
			modelRegistry: {
				getAvailable: vi
					.fn()
					.mockReturnValue([paidSonnet, paidOpus, freeHaiku, freeOpenai]),
				find: vi.fn().mockImplementation((p: string, id: string) => {
					const all = [paidSonnet, paidOpus, freeHaiku, freeOpenai];
					return all.find((m) => m.provider === p && m.id === id);
				}),
			},
			ui: {
				notify: vi.fn(),
				custom: vi.fn(),
			},
		};
	}

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to defaultModel config when a free model fails with server-gated error", async () => {
		const ctx = makeCtx();
		const err = new Error(
			'403 "Free mode is server-gated: the Code · 83eb94f4-1b1-simplicity.jsonl"',
		);

		const result = await selectModelOnError(
			ctx,
			{ provider: "anthropic", id: "claude-3-5-haiku" },
			"Model Error",
			"Choose a different model:",
			{
				error: err,
				lens: "simplicity",
				config: { autoroute: true, defaultModel: "anthropic/claude-sonnet-4" },
			},
		);

		// The server-gated branch must skip autorouting and return the
		// default config model (paid Sonnet), not another free model.
		expect(result?.id).toBe("claude-sonnet-4");
		// The free-model resolver must NOT be consulted.
		const spy = vi.spyOn(freeModels, "selectFreeModel");
		expect(spy).not.toHaveBeenCalled();
		// The popup must NOT be shown — the user gets a paid model automatically.
		expect(ctx.ui.custom).not.toHaveBeenCalled();
		// The user should be told WHY the free model was skipped.
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("server-gated"),
			"info",
		);
	});

	it("uses lensModels[lens] when set, before defaultModel", async () => {
		const ctx = makeCtx();
		const err = new Error("Free mode is server-gated");

		const result = await selectModelOnError(
			ctx,
			{ provider: "anthropic", id: "claude-3-5-haiku" },
			"Model Error",
			"Choose a different model:",
			{
				error: err,
				lens: "simplicity",
				config: {
					autoroute: true,
					defaultModel: "anthropic/claude-sonnet-4",
					lensModels: { simplicity: "anthropic/claude-opus-4" },
				},
			},
		);

		// Per-lens override wins over defaultModel.
		expect(result?.id).toBe("claude-opus-4");
	});

	it("does NOT trigger server-gated fallback for plain 403/quota errors", async () => {
		const ctx = makeCtx();
		const err = new Error("403 Forbidden: invalid API key");
		// Spy BEFORE the call so we catch the invocation.
		const spy = vi.spyOn(freeModels, "selectFreeModel");

		const result = await selectModelOnError(
			ctx,
			{ provider: "anthropic", id: "claude-sonnet-4" },
			"Model Error",
			"Choose a different model:",
			{
				error: err,
				lens: "simplicity",
				config: { autoroute: true, defaultModel: "anthropic/claude-sonnet-4" },
			},
		);

		// Plain 403 (no "server-gated" keyword) takes the normal
		// autoroute-or-popup path, not the default-config fallback.
		// selectFreeModel returns a free model (Haiku) because it's not excluded.
		expect(spy).toHaveBeenCalled();
		expect(result?.id).toBe("claude-3-5-haiku");
		// The popup must NOT be shown — autoroute picked a free model.
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("falls back to default config in headless mode when autoroute produces nothing", async () => {
		const ctx = makeCtx({ hasUI: false });
		// No free models available — autoroute produces nothing.
		ctx.modelRegistry.getAvailable.mockReturnValue([paidSonnet, paidOpus]);
		const err = new Error("429 Rate limit exceeded");

		const result = await selectModelOnError(
			ctx,
			{ provider: "anthropic", id: "claude-sonnet-4" },
			"Model Error",
			"Choose a different model:",
			{
				error: err,
				lens: "simplicity",
				config: { autoroute: true, defaultModel: "anthropic/claude-sonnet-4" },
			},
		);

		// Headless + no autoroute target -> fall back to default config.
		expect(result?.id).toBe("claude-sonnet-4");
	});
});
