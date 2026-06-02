import { describe, it, expect, vi, beforeEach } from "vitest";
import { findModelByHint, resolveModelSmart, callLLM } from "./llm.js";
import { loadConfig, getModelForLens, saveConfig } from "./config.js";
import { selectModelWithAutoroute } from "./model-selector.js";
import { complete } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";

vi.mock("./config.js", () => ({
	loadConfig: vi.fn().mockResolvedValue({ interactive: false }),
	getModelForLens: vi.fn().mockImplementation((config: any, lens?: string) => {
		if (lens && config.lensModels?.[lens]) return config.lensModels[lens];
		return config.defaultModel;
	}),
	saveConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./model-selector.js", () => ({
	selectModel: vi.fn().mockResolvedValue(undefined),
	selectModelWithAutoroute: vi.fn().mockResolvedValue(undefined),
	isQuotaError: vi.fn().mockReturnValue(false),
	isAuthError: vi.fn().mockReturnValue(false),
	isModelError: vi.fn().mockReturnValue(false),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	complete: vi.fn(),
}));

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

describe("resolveModelSmart", () => {
	const models = [
		mockModel("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4"),
		mockModel("openai", "gpt-4o", "GPT-4o"),
	];

	function makeCtx(overrides?: { interactive?: boolean; hasUI?: boolean }) {
		return {
			cwd: "/test",
			modelRegistry: {
				getAvailable: vi.fn().mockReturnValue(models),
			},
			hasUI: overrides?.hasUI ?? false,
			ui: { notify: vi.fn() },
		} as any;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadConfig).mockResolvedValue({ interactive: false } as any);
		vi.mocked(getModelForLens).mockImplementation(
			(config: any, lens?: string) => {
				if (lens && config.lensModels?.[lens]) return config.lensModels[lens];
				return config.defaultModel;
			},
		);
	});

	it("returns undefined when no models available", async () => {
		const ctx = makeCtx();
		ctx.modelRegistry.getAvailable.mockReturnValue([]);
		const result = await resolveModelSmart(ctx, "/test");
		expect(result).toBeUndefined();
	});

	it("uses explicit hint when provided", async () => {
		const ctx = makeCtx();
		const result = await resolveModelSmart(ctx, "/test", "gpt");
		expect(result?.id).toBe("gpt-4o");
	});

	it("falls back to per-lens config", async () => {
		const ctx = makeCtx();
		vi.mocked(getModelForLens).mockReturnValue(
			"anthropic/claude-sonnet-4-20250514",
		);
		const result = await resolveModelSmart(
			ctx,
			"/test",
			undefined,
			"simplicity",
		);
		expect(result?.id).toBe("claude-sonnet-4-20250514");
	});

	it("falls back to default model from config", async () => {
		const ctx = makeCtx();
		// Set up loadConfig to return config with defaultModel for this test
		vi.mocked(loadConfig).mockResolvedValue({
			defaultModel: "openai/gpt-4o",
		} as any);
		const result = await resolveModelSmart(ctx, "/test");
		expect(result?.id).toBe("gpt-4o");
	});

	it("returns first available model as final fallback", async () => {
		const ctx = makeCtx();
		const result = await resolveModelSmart(ctx, "/test");
		expect(result?.id).toBe("claude-sonnet-4-20250514");
	});

	it("skips interactive selector when hasUI is false", async () => {
		const ctx = makeCtx({ hasUI: false });
		vi.mocked(loadConfig).mockResolvedValue({ interactive: true } as any);
		const result = await resolveModelSmart(ctx, "/test");
		// Should fall through to first available model
		expect(result?.id).toBe("claude-sonnet-4-20250514");
		expect(selectModelWithAutoroute).not.toHaveBeenCalled();
	});

	it("saves autoroute-picked model as default", async () => {
		const freeModel = mockModel("anthropic", "claude-3-5-haiku", "Haiku");
		const ctx = makeCtx({ hasUI: true });
		vi.mocked(loadConfig).mockResolvedValue({
			autoroute: true,
			modelScope: "haiku",
		} as any);
		vi.mocked(selectModelWithAutoroute).mockResolvedValue(freeModel);

		const result = await resolveModelSmart(ctx, "/test");
		expect(result?.id).toBe("claude-3-5-haiku");
		expect(saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultModel: "anthropic/claude-3-5-haiku",
			}),
		);
	});
});

describe("callLLM", () => {
	const models = [
		mockModel("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4"),
	];

	function makeCtx() {
		return {
			cwd: "/test",
			modelRegistry: {
				getAvailable: vi.fn().mockReturnValue(models),
				getApiKeyAndHeaders: vi
					.fn()
					.mockResolvedValue({ ok: true, key: "test-key" }),
			},
			hasUI: false,
			ui: { notify: vi.fn() },
		} as any;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadConfig).mockResolvedValue({ interactive: false } as any);
		vi.mocked(complete).mockResolvedValue({
			content: [{ type: "text", text: "response" }],
		} as any);
	});

	it("returns text from LLM response", async () => {
		const ctx = makeCtx();
		const result = await callLLM(ctx, "/test", "system", "user");
		expect(result.text).toBe("response");
		expect(result.model.id).toBe("claude-sonnet-4-20250514");
	});

	it("throws when no model available", async () => {
		const ctx = makeCtx();
		ctx.modelRegistry.getAvailable.mockReturnValue([]);
		await expect(callLLM(ctx, "/test", "system", "user")).rejects.toThrow(
			"No model available",
		);
	});

	it("throws when API key is missing", async () => {
		const ctx = makeCtx();
		ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
			ok: false,
			error: "No key",
		});
		await expect(callLLM(ctx, "/test", "system", "user")).rejects.toThrow(
			"No API key",
		);
	});

	it("retries on quota error when hasUI is true", async () => {
		const { isModelError } = await import("./model-selector.js");
		vi.mocked(isModelError).mockReturnValueOnce(true);
		const ctx = makeCtx();
		ctx.hasUI = true;

		// First call fails with quota error, second succeeds
		vi.mocked(complete)
			.mockRejectedValueOnce(new Error("Rate limit"))
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "retry-success" }],
			} as any);
		vi.mocked(selectModelWithAutoroute).mockResolvedValue(models[0]);

		const result = await callLLM(ctx, "/test", "system", "user");
		expect(result.text).toBe("retry-success");
		expect(selectModelWithAutoroute).toHaveBeenCalled();
	});

	it("retries on auth error when hasUI is true", async () => {
		const { isModelError } = await import("./model-selector.js");
		vi.mocked(isModelError).mockReturnValueOnce(true);
		const ctx = makeCtx();
		ctx.hasUI = true;

		vi.mocked(complete)
			.mockRejectedValueOnce(new Error("Unauthorized"))
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "retry-success" }],
			} as any);
		vi.mocked(selectModelWithAutoroute).mockResolvedValue(models[0]);

		const result = await callLLM(ctx, "/test", "system", "user");
		expect(result.text).toBe("retry-success");
	});

	it("retries on 5xx server error and autoroutes regardless of hasUI", async () => {
		// 5xx detection is the key fix: prior to this, a 504 on a headless
		// invocation would skip the retry entirely and bubble the raw error.
		const { isModelError } = await import("./model-selector.js");
		vi.mocked(isModelError).mockReturnValueOnce(true);
		const ctx = makeCtx();
		ctx.hasUI = false; // headless

		vi.mocked(complete)
			.mockRejectedValueOnce(new Error("504 status code (no body)"))
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "autoroute-recovered" }],
			} as any);
		vi.mocked(selectModelWithAutoroute).mockResolvedValue(models[0]);

		const result = await callLLM(ctx, "/test", "system", "user");
		expect(result.text).toBe("autoroute-recovered");
		expect(selectModelWithAutoroute).toHaveBeenCalled();
	});

	it("passes the failed model as excluded to selectModelWithAutoroute on retry", async () => {
		const { isModelError } = await import("./model-selector.js");
		vi.mocked(isModelError).mockReturnValueOnce(true);
		const ctx = makeCtx();
		ctx.hasUI = true;

		vi.mocked(complete)
			.mockRejectedValueOnce(new Error("Rate limit"))
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "ok" }],
			} as any);
		vi.mocked(selectModelWithAutoroute).mockResolvedValue(models[0]);

		await callLLM(ctx, "/test", "system", "user");
		expect(selectModelWithAutoroute).toHaveBeenCalledWith(
			ctx,
			expect.anything(),
			expect.any(String),
			expect.any(String),
			expect.objectContaining({
				provider: "anthropic",
				id: "claude-sonnet-4-20250514",
			}),
		);
	});

	it("throws the original error when autoroute returns undefined (no free model, no UI)", async () => {
		const { isModelError } = await import("./model-selector.js");
		vi.mocked(isModelError).mockReturnValueOnce(true);
		const ctx = makeCtx();
		ctx.hasUI = false; // headless

		vi.mocked(complete).mockRejectedValueOnce(new Error("Rate limit"));
		vi.mocked(selectModelWithAutoroute).mockResolvedValue(undefined);

		await expect(callLLM(ctx, "/test", "system", "user")).rejects.toThrow(
			"Rate limit",
		);
	});
});
