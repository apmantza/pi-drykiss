import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./prompt-loader.js", () => ({
	loadPromptBody: vi.fn(),
}));

import { loadPromptBody } from "./prompt-loader.js";
import {
	modeToPosture,
	loadModeContextBlock,
	MODE_CONTEXT_FRAGMENT_NAMES,
} from "./mode-context.js";

beforeEach(() => {
	vi.resetAllMocks();
});

describe("modeToPosture", () => {
	it("maps full → audit (no coherent diff to gate)", () => {
		expect(modeToPosture("full")).toBe("audit");
	});

	it("maps local → proposed", () => {
		expect(modeToPosture("local")).toBe("proposed");
	});

	it("maps staged → proposed", () => {
		expect(modeToPosture("staged")).toBe("proposed");
	});

	it("maps branch → proposed", () => {
		expect(modeToPosture("branch")).toBe("proposed");
	});

	it("maps commit → proposed", () => {
		expect(modeToPosture("commit")).toBe("proposed");
	});

	it("maps pr → proposed", () => {
		expect(modeToPosture("pr")).toBe("proposed");
	});

	it("maps files → proposed", () => {
		expect(modeToPosture("files")).toBe("proposed");
	});

	it("defaults undefined → proposed", () => {
		expect(modeToPosture(undefined)).toBe("proposed");
	});

	it("defaults unknown mode → proposed", () => {
		expect(modeToPosture("nonsense")).toBe("proposed");
	});
});

describe("loadModeContextBlock", () => {
	it("loads and substitutes the proposed fragment", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue(
			"PROPOSED scope={{scope_label}} posture={{posture}}",
		);
		const block = await loadModeContextBlock("proposed", "owner/repo#42");
		expect(block).toBe("PROPOSED scope=owner/repo#42 posture=proposed");
		expect(loadPromptBody).toHaveBeenCalledWith(
			MODE_CONTEXT_FRAGMENT_NAMES.proposed,
			"shared",
		);
	});

	it("loads and substitutes the audit fragment", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue("AUDIT {{scope_label}}");
		const block = await loadModeContextBlock("audit", "full codebase");
		expect(block).toBe("AUDIT full codebase");
		expect(loadPromptBody).toHaveBeenCalledWith(
			MODE_CONTEXT_FRAGMENT_NAMES.audit,
			"shared",
		);
	});

	it("omits scope_label placeholder when no label is given", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue("AUDIT [{{scope_label}}]");
		const block = await loadModeContextBlock("audit");
		expect(block).toBe("AUDIT []");
	});

	it("returns empty string when the fragment is missing (fail-open)", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue(undefined as unknown as string);
		const block = await loadModeContextBlock("proposed", "pr#1");
		expect(block).toBe("");
	});

	it("returns empty string when the fragment is whitespace-only", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue("   \n  ");
		const block = await loadModeContextBlock("audit");
		expect(block).toBe("");
	});

	it("returns empty string and logs a warning when loadPromptBody throws", async () => {
		const consoleSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		vi.mocked(loadPromptBody).mockRejectedValue(new Error("ENOENT"));
		const block = await loadModeContextBlock("proposed", "pr#1");
		expect(block).toBe("");
		expect(loadPromptBody).toHaveBeenCalledWith(
			MODE_CONTEXT_FRAGMENT_NAMES.proposed,
			"shared",
		);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Could not load mode context fragment"),
		);
		consoleSpy.mockRestore();
	});

	it("trims whitespace from a non-empty template", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue(
			"  \n  PROPOSED {{scope_label}}  \n  ",
		);
		const block = await loadModeContextBlock("proposed", "x");
		expect(block).toBe("PROPOSED x");
	});

	it("leaves unknown placeholders unchanged", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue(
			"PROPOSED {{unknown}} {{scope_label}}",
		);
		const block = await loadModeContextBlock("proposed", "y");
		expect(block).toBe("PROPOSED {{unknown}} y");
	});
});
