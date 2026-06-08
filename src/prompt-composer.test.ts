import { describe, it, expect, vi } from "vitest";
import {
	composeLensPrompt,
	composeSynthesisPrompt,
} from "./prompt-composer.js";

// Mock prompt-loader so we don't hit the filesystem
vi.mock("./prompt-loader.js", () => ({
	loadPromptBody: vi.fn(async (name: string, kind: string) => {
		if (name === "iron-law") return "### Iron Law\nNever violate KISS/DRY.";
		if (name === "simplicity") return "# Simplicity Auditor\nFind complexity.";
		if (name === "synthesis") return "# Synthesizer\nMerge findings.";
		if (name === "json-output") return "```json\n{ findings: [] }\n```";
		if (name === "json-output-synthesis")
			return '```json\n{ summary: "" }\n```';
		if (name === "grounding-rules") return "## Grounding\nBe specific.";
		if (name === "grounding-rules-synthesis")
			return "## Synthesis Grounding\nCross-validate.";
		if (name === "kiss-dry-checklist")
			return "## KISS/DRY Checklist\n- [ ] KISS";
		if (name === "active-constraints")
			return "## Active Constraints\n{{active_constraints}}";
		throw new Error(`Unknown prompt: ${name}`);
	}),
	loadSharedFragment: vi.fn().mockRejectedValue(new Error("not used")),
	bundledPromptsDir: vi.fn().mockReturnValue("/mock/prompts"),
}));

describe("composeLensPrompt", () => {
	it("composes a lens prompt with all shared fragments", async () => {
		const result = await composeLensPrompt("simplicity");
		expect(result).toContain("### Iron Law");
		expect(result).toContain("# Simplicity Auditor");
		expect(result).toContain("```json");
		expect(result).toContain("## Grounding");
		expect(result).toContain("## KISS/DRY Checklist");
	});

	it("includes active constraints when provided", async () => {
		const result = await composeLensPrompt("simplicity", {
			activeConstraints: "Do not suggest try-catch.",
		});
		expect(result).toContain("Do not suggest try-catch.");
		expect(result).toContain("## Active Constraints");
	});

	it("omits active constraints section when not provided", async () => {
		const result = await composeLensPrompt("simplicity");
		expect(result).not.toContain("Active Constraints");
	});

	it("substitutes the placeholder in active constraints template", async () => {
		const result = await composeLensPrompt("simplicity", {
			activeConstraints: "Focus on error handling.",
		});
		// The placeholder should be gone, replaced with the constraint text
		expect(result).not.toContain("{{active_constraints}}");
		expect(result).toContain("Focus on error handling.");
	});

	it("preserves unmatched placeholders in body content", async () => {
		// If there's a {{other}} placeholder in a prompt, it should survive substitution
		// (only {{active_constraints}} is substituted)
		const { loadPromptBody } = await import("./prompt-loader.js");
		vi.mocked(loadPromptBody).mockImplementationOnce(
			async (name: string) => `### Iron Law\n{{other_placeholder}}`,
		);
		const result = await composeLensPrompt("simplicity");
		expect(result).toContain("{{other_placeholder}}");
	});
});

describe("composeSynthesisPrompt", () => {
	it("composes a synthesis prompt with synthesis-specific fragments", async () => {
		const result = await composeSynthesisPrompt();
		expect(result).toContain("### Iron Law");
		expect(result).toContain("# Synthesizer");
		expect(result).toContain("```json");
		expect(result).toContain("## Synthesis Grounding");
	});

	it("includes active constraints when provided", async () => {
		const result = await composeSynthesisPrompt({
			activeConstraints: "Be concise.",
		});
		expect(result).toContain("Be concise.");
		expect(result).toContain("## Active Constraints");
	});

	it("omits kiss-dry-checklist (not used in synthesis)", async () => {
		const result = await composeSynthesisPrompt();
		expect(result).not.toContain("KISS/DRY Checklist");
	});

	it("omits active constraints section when not provided", async () => {
		const result = await composeSynthesisPrompt();
		expect(result).not.toContain("Active Constraints");
	});
});
