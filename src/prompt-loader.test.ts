import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
}));

beforeEach(async () => {
	vi.resetAllMocks();
	const { clearPromptCache } = await import("./prompt-loader.js");
	clearPromptCache();
});

describe("loadPromptFile", () => {
	it("reads a .md file from the given source dir", async () => {
		vi.mocked(readFile).mockResolvedValue("# Test Prompt\ncontent");
		const { loadPromptFile } = await import("./prompt-loader.js");
		const result = await loadPromptFile({ dir: "/prompts" }, "test-lens");
		expect(readFile).toHaveBeenCalledWith(
			expect.stringMatching(/test-lens\.md$/),
			"utf8",
		);
		expect(result).toContain("# Test Prompt");
	});

	it("throws with ENOENT code when file content is null", async () => {
		vi.mocked(readFile).mockResolvedValue(null as unknown as string);
		const { loadPromptFile } = await import("./prompt-loader.js");
		await expect(
			loadPromptFile({ dir: "/prompts" }, "missing"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("loadSharedFragment", () => {
	it("reads from _shared subdirectory", async () => {
		vi.mocked(readFile).mockResolvedValue("shared content");
		const { loadSharedFragment } = await import("./prompt-loader.js");
		await loadSharedFragment({ dir: "/prompts" }, "grounding-rules");
		expect(readFile).toHaveBeenCalledWith(
			expect.stringMatching(/[\\/]_shared[\\/]grounding-rules\.md$/),
			"utf8",
		);
	});

	it("throws with ENOENT code when file content is null", async () => {
		vi.mocked(readFile).mockResolvedValue(null as unknown as string);
		const { loadSharedFragment } = await import("./prompt-loader.js");
		await expect(
			loadSharedFragment({ dir: "/prompts" }, "missing"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("resolvePromptsDir", () => {
	beforeEach(() => {
		delete process.env.DRYKISS_PROMPTS_DIR;
	});

	it("returns env var when set (absolute path)", async () => {
		process.env.DRYKISS_PROMPTS_DIR = "/custom/prompts";
		const { resolvePromptsDir } = await import("./prompt-loader.js");
		expect(resolvePromptsDir()).toBe("/custom/prompts");
	});

	it("resolves relative env var against cwd", async () => {
		process.env.DRYKISS_PROMPTS_DIR = "my/prompts";
		const { resolvePromptsDir } = await import("./prompt-loader.js");
		expect(resolvePromptsDir()).toContain("my");
		expect(resolvePromptsDir()).toContain("prompts");
	});

	it("returns user prompts dir when env is empty", async () => {
		process.env.DRYKISS_PROMPTS_DIR = "";
		const { resolvePromptsDir } = await import("./prompt-loader.js");
		expect(resolvePromptsDir()).toContain(".pi");
		expect(resolvePromptsDir()).toContain("drykiss");
		expect(resolvePromptsDir()).toContain("prompts");
	});

	it("returns user prompts dir when env is whitespace", async () => {
		process.env.DRYKISS_PROMPTS_DIR = "   ";
		const { resolvePromptsDir } = await import("./prompt-loader.js");
		expect(resolvePromptsDir()).toContain(".pi");
		expect(resolvePromptsDir()).toContain("drykiss");
		expect(resolvePromptsDir()).toContain("prompts");
	});
});

describe("loadPromptBody", () => {
	beforeEach(() => {
		delete process.env.DRYKISS_PROMPTS_DIR;
	});

	it("caches successful loads and reuses them on subsequent calls", async () => {
		vi.mocked(readFile)
			.mockRejectedValueOnce(
				Object.assign(new Error("not found"), { code: "ENOENT" as const }),
			)
			.mockResolvedValueOnce("bundled prompt content");
		const { loadPromptBody } = await import("./prompt-loader.js");

		const first = await loadPromptBody("cached-lens", "lens");
		const second = await loadPromptBody("cached-lens", "lens");

		expect(first).toBe("bundled prompt content");
		expect(second).toBe("bundled prompt content");
		// First call tries user dir (ENOENT) then bundled dir (success) = 2 reads.
		// Second call should hit the cache and not touch the filesystem.
		expect(readFile).toHaveBeenCalledTimes(2);
	});

	it("falls back to bundled prompts on ENOENT from user dir", async () => {
		vi.mocked(readFile)
			.mockRejectedValueOnce(
				Object.assign(new Error("not found"), { code: "ENOENT" as const }),
			)
			.mockResolvedValueOnce("bundled prompt content");
		const { loadPromptBody } = await import("./prompt-loader.js");
		const result = await loadPromptBody("some-lens", "lens");
		expect(result).toBe("bundled prompt content");
	});

	it("rethrows non-ENOENT errors from user dir", async () => {
		vi.mocked(readFile).mockRejectedValue(new Error("Permission denied"));
		const { loadPromptBody } = await import("./prompt-loader.js");
		await expect(loadPromptBody("some-lens", "lens")).rejects.toThrow(
			"Permission denied",
		);
	});

	it("loads shared fragments with bundled fallback", async () => {
		vi.mocked(readFile)
			.mockRejectedValueOnce(
				Object.assign(new Error("not found"), { code: "ENOENT" as const }),
			)
			.mockResolvedValueOnce("bundled shared content");
		const { loadPromptBody } = await import("./prompt-loader.js");
		const result = await loadPromptBody("iron-law", "shared");
		expect(result).toBe("bundled shared content");
	});

	it("uses env var short-circuit when set", async () => {
		process.env.DRYKISS_PROMPTS_DIR = "/env/prompts";
		vi.mocked(readFile).mockResolvedValue("env prompt content");
		const { loadPromptBody } = await import("./prompt-loader.js");
		const result = await loadPromptBody("env-lens", "lens");
		expect(result).toBe("env prompt content");
		delete process.env.DRYKISS_PROMPTS_DIR;
	});
});
