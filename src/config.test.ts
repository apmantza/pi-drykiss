import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
	loadConfig,
	saveConfig,
	getModelForLens,
	setLensModel,
	setDefaultModel,
} from "./config.js";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(mkdir).mockResolvedValue(undefined);
});

describe("loadConfig", () => {
	it("returns parsed config when file exists", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ defaultModel: "sonnet", interactive: false }),
		);
		const config = await loadConfig("/cwd");
		expect(config.defaultModel).toBe("sonnet");
		expect(config.interactive).toBe(false);
	});

	it("returns defaults when file is missing", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("file not found"), { code: "ENOENT" as const }),
		);
		const config = await loadConfig("/cwd");
		expect(config.defaultModel).toBeUndefined();
		expect(config.interactive).toBe(true);
		expect(config.confirmBeforeRun).toBe(true);
	});

	it("returns defaults when file has invalid JSON", async () => {
		vi.mocked(readFile).mockResolvedValue("not json");
		const config = await loadConfig("/cwd");
		expect(config.interactive).toBe(true);
	});
});

describe("saveConfig", () => {
	it("writes config to .pi/drykiss/config.json", async () => {
		vi.mocked(writeFile).mockResolvedValue(undefined);
		await saveConfig("/cwd", { defaultModel: "haiku", interactive: false });
		expect(mkdir).toHaveBeenCalled();
		const mkdirPath = vi.mocked(mkdir).mock.calls[0][0] as string;
		expect(mkdirPath).toMatch(/\.pi[/\\]drykiss$/);
		expect(writeFile).toHaveBeenCalled();
		const written = vi.mocked(writeFile).mock.calls[0][1] as string;
		const parsed = JSON.parse(written);
		expect(parsed.defaultModel).toBe("haiku");
		expect(parsed.interactive).toBe(false);
	});
});

describe("getModelForLens", () => {
	it("returns per-lens model when set", () => {
		const config = {
			lensModels: { simplicity: "haiku", deduplication: "sonnet" },
			defaultModel: "opus",
		};
		expect(getModelForLens(config, "simplicity")).toBe("haiku");
		expect(getModelForLens(config, "deduplication")).toBe("sonnet");
	});

	it("falls back to default model", () => {
		const config = { defaultModel: "opus", lensModels: { clarity: "sonnet" } };
		expect(getModelForLens(config, "simplicity")).toBe("opus");
		expect(getModelForLens(config, "synthesis")).toBe("opus");
	});

	it("returns undefined when nothing configured", () => {
		expect(getModelForLens({}, "simplicity")).toBeUndefined();
	});

	it("handles unknown lens gracefully", () => {
		const config = { defaultModel: "opus" };
		expect(getModelForLens(config, "nonexistent" as any)).toBe("opus");
	});
});

describe("setLensModel", () => {
	it("sets per-lens model and preserves existing config", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				defaultModel: "opus",
				lensModels: { simplicity: "haiku" },
			}),
		);
		vi.mocked(writeFile).mockResolvedValue(undefined);
		await setLensModel("/cwd", "clarity", "sonnet");
		const written = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
		expect(written.lensModels).toEqual({
			simplicity: "haiku",
			clarity: "sonnet",
		});
		expect(written.defaultModel).toBe("opus");
	});
});

describe("setDefaultModel", () => {
	it("sets default model", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("file not found"), { code: "ENOENT" as const }),
		);
		vi.mocked(writeFile).mockResolvedValue(undefined);
		await setDefaultModel("/cwd", "sonnet");
		const written = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
		expect(written.defaultModel).toBe("sonnet");
	});
});
