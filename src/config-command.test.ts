import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleConfigCommand } from "./config-command.js";
import {
	loadConfig,
	saveConfig,
	setLensModel,
	setDefaultModel,
} from "./config.js";
import { selectModel } from "./model-selector.js";
import { resetPrompts } from "./prompt-builder.js";

vi.mock("./config.js", () => ({
	getConfigPath: vi.fn().mockReturnValue("/mock/config.json"),
	loadConfig: vi.fn(),
	saveConfig: vi.fn().mockResolvedValue(undefined),
	setLensModel: vi.fn().mockResolvedValue(undefined),
	setDefaultModel: vi.fn().mockResolvedValue(undefined),
	getModelForLens: vi.fn(),
}));

vi.mock("./model-selector.js", () => ({
	selectModel: vi.fn(),
}));

vi.mock("./prompt-builder.js", () => ({
	resetPrompts: vi.fn().mockResolvedValue(undefined),
}));

function mockCtx(): any {
	return {
		cwd: "/cwd",
		ui: {
			notify: vi.fn(),
			confirm: vi.fn().mockResolvedValue(true),
		},
		hasUI: true,
	};
}

describe("handleConfigCommand", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("shows current config with show subcommand", async () => {
		vi.mocked(loadConfig).mockResolvedValue({
			defaultModel: "sonnet",
			lensModels: { simplicity: "haiku", clarity: "sonnet" },
			interactive: true,
			confirmBeforeRun: true,
			contextMode: "full",
		});
		const ctx = mockCtx();
		await handleConfigCommand("show", ctx);
		expect(ctx.ui.notify).toHaveBeenCalled();
		const msg = vi.mocked(ctx.ui.notify).mock.calls[0][0] as string;
		expect(msg).toContain("sonnet");
		expect(msg).toContain("haiku");
		expect(msg).toContain("full");
	});

	it("shows current config when no subcommand given", async () => {
		vi.mocked(loadConfig).mockResolvedValue({});
		const ctx = mockCtx();
		await handleConfigCommand("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalled();
		const msg = vi.mocked(ctx.ui.notify).mock.calls[0][0] as string;
		expect(msg).toContain("DRYKISS Configuration");
	});

	it("sets default model", async () => {
		const ctx = mockCtx();
		await handleConfigCommand("set-default haiku", ctx);
		expect(setDefaultModel).toHaveBeenCalledWith("haiku");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("haiku"),
			"info",
		);
	});

	it("opens model picker when set-default has no model", async () => {
		vi.mocked(selectModel).mockResolvedValue({
			provider: "anthropic",
			id: "claude-haiku",
			name: "Haiku",
		} as any);
		const ctx = mockCtx();
		await handleConfigCommand("set-default", ctx);
		expect(selectModel).toHaveBeenCalled();
		expect(setDefaultModel).toHaveBeenCalledWith("anthropic/claude-haiku");
	});

	it("sets per-lens model", async () => {
		const ctx = mockCtx();
		await handleConfigCommand("set-lens clarity sonnet", ctx);
		expect(setLensModel).toHaveBeenCalledWith("clarity", "sonnet");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("sonnet"),
			"info",
		);
	});

	it("rejects invalid lens", async () => {
		const ctx = mockCtx();
		await handleConfigCommand("set-lens invalid-model sonnet", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Invalid lens"),
			"error",
		);
		expect(setLensModel).not.toHaveBeenCalled();
	});

	it("toggles interactive on", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ interactive: false });
		const ctx = mockCtx();
		await handleConfigCommand("interactive on", ctx);
		expect(saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ interactive: true }),
		);
	});

	it("toggles interactive off", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ interactive: true });
		const ctx = mockCtx();
		await handleConfigCommand("interactive off", ctx);
		expect(saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ interactive: false }),
		);
	});

	it("toggles confirm on", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ confirmBeforeRun: false });
		const ctx = mockCtx();
		await handleConfigCommand("confirm on", ctx);
		expect(saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ confirmBeforeRun: true }),
		);
	});

	it("toggles confirm off", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ confirmBeforeRun: true });
		const ctx = mockCtx();
		await handleConfigCommand("confirm off", ctx);
		expect(saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ confirmBeforeRun: false }),
		);
	});

	it("sets context-mode to diff", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ contextMode: "full" });
		const ctx = mockCtx();
		await handleConfigCommand("context-mode diff", ctx);
		expect(saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ contextMode: "diff" }),
		);
	});

	it("sets context-mode to full", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ contextMode: "diff" });
		const ctx = mockCtx();
		await handleConfigCommand("context-mode full", ctx);
		expect(saveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ contextMode: "full" }),
		);
	});

	it("rejects invalid context-mode value", async () => {
		const ctx = mockCtx();
		await handleConfigCommand("context-mode invalid", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Usage"),
			"warning",
		);
		expect(saveConfig).not.toHaveBeenCalled();
	});

	it("resets prompts", async () => {
		const ctx = mockCtx();
		await handleConfigCommand("reset-prompts", ctx);
		expect(resetPrompts).toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("regenerated"),
			"info",
		);
	});

	it("reports unknown subcommand", async () => {
		const ctx = mockCtx();
		await handleConfigCommand("unknown-thing", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Unknown subcommand"),
			"error",
		);
	});
});
