import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./prompt-loader.js", () => ({
	loadPromptBody: vi.fn(),
}));

import { loadPromptBody } from "./prompt-loader.js";
import {
	modeToPosture,
	postureHasDiff,
	loadModeContextBlock,
} from "./mode-context.js";

beforeEach(() => {
	vi.resetAllMocks();
});

describe("modeToPosture", () => {
	it("maps full → audit (no coherent diff to gate)", () => {
		expect(modeToPosture("full")).toBe("audit");
	});

	it("maps every change-based mode → proposed", () => {
		for (const m of ["local", "staged", "branch", "commit", "pr", "files"]) {
			expect(modeToPosture(m)).toBe("proposed");
		}
	});

	it("defaults undefined/unknown → proposed (preserves historical behavior)", () => {
		// The lens prompts were written assuming a diff exists, so unknown
		// modes must fall back to the proposed-change posture, not audit.
		expect(modeToPosture(undefined)).toBe("proposed");
		expect(modeToPosture("nonsense")).toBe("proposed");
	});
});

describe("postureHasDiff", () => {
	it("proposed has a meaningful per-file diff", () => {
		expect(postureHasDiff("proposed")).toBe(true);
	});

	it("audit has no coherent diff to reason about", () => {
		expect(postureHasDiff("audit")).toBe(false);
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
			"mode-context-proposed",
			"shared",
		);
	});

	it("loads and substitutes the audit fragment", async () => {
		vi.mocked(loadPromptBody).mockResolvedValue("AUDIT {{scope_label}}");
		const block = await loadModeContextBlock("audit", "full codebase");
		expect(block).toBe("AUDIT full codebase");
		expect(loadPromptBody).toHaveBeenCalledWith("mode-context-audit", "shared");
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
});
