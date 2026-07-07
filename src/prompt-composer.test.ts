import { describe, it, expect, vi } from "vitest";
import {
	composeLensPrompt,
	composeSynthesisPrompt,
} from "./prompt-composer.js";

// Mock prompt-loader so we don't hit the filesystem
vi.mock("./prompt-loader.js", () => ({
	loadPromptBody: vi.fn(async (name: string, _kind: string) => {
		if (name === "iron-law") return "### Iron Law\nNever violate KISS/DRY.";
		if (name === "simplicity") return "# Simplicity Auditor\nFind complexity.";
		if (name === "synthesis") return "# Synthesizer\nMerge findings.";
		if (name === "json-output") return "```json\n{ findings: [] }\n```";
		if (name === "json-output-synthesis")
			return '```json\n{ summary: "" }\n```';
		if (name === "grounding-rules")
			return "## Grounding\nBe specific.\n### Quick Self-Check\n- [ ] KISS";
		if (name === "grounding-rules-synthesis")
			return "## Synthesis Calibration\nFinal filter rules.";
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
		expect(result).toContain("### Quick Self-Check");
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
			async (_name: string) => `### Iron Law\n{{other_placeholder}}`,
		);
		const result = await composeLensPrompt("simplicity");
		expect(result).toContain("{{other_placeholder}}");
	});
});

describe("composeSynthesisPrompt", () => {
	it("composes a synthesis prompt with the shared grounding rules", async () => {
		const result = await composeSynthesisPrompt();
		expect(result).toContain("### Iron Law");
		expect(result).toContain("# Synthesizer");
		expect(result).toContain("```json");
		expect(result).toContain("## Grounding");
		expect(result).toContain("## Synthesis Calibration");
	});

	it("includes active constraints when provided", async () => {
		const result = await composeSynthesisPrompt({
			activeConstraints: "Be concise.",
		});
		expect(result).toContain("Be concise.");
		expect(result).toContain("## Active Constraints");
	});

	it("includes both grounding rules and synthesis-calibration rules in synthesis", async () => {
		const result = await composeSynthesisPrompt();
		expect(result).toContain("## Grounding");
		expect(result).toContain("### Quick Self-Check");
		expect(result).toContain("## Synthesis Calibration");
	});

	it("omits active constraints section when not provided", async () => {
		const result = await composeSynthesisPrompt();
		expect(result).not.toContain("Active Constraints");
	});
});

/**
 * Prompt-structure tests. These read the *real* bundled .md
 * files and assert on the *shape* of the lens bodies — what's
 * present, what isn't. They catch the kind of regression where
 * the cross-cutting rules (already in shared fragments) get
 * re-stated in a lens body, or where a lens body grows to
 * duplicate what the composer already stitches in.
 */
describe("simplicity lens body (bundled prompt structure)", () => {
	it("is loaded from the bundled src/prompts/simplicity.md", async () => {
		// The test runner runs from the project root, so a relative
		// path of "src/prompts/simplicity.md" resolves correctly.
		const { readFile } = await import("node:fs/promises");
		const content = await readFile("src/prompts/simplicity.md", "utf8");
		expect(content.length).toBeGreaterThan(500);
	});

	it("opens with the role statement in the same one-line style as the other lenses", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile("src/prompts/simplicity.md", "utf8");
		expect(content.split("\n")[0]).toBe(
			"You are a Simplicity Auditor. Your ONLY job is to find unnecessary complexity in code. Be AMBITIOUS — don't just suggest cleanup, look for dramatic simplifications.",
		);
	});

	it("defines the decision procedure (the ladder) as a numbered list of rungs", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile("src/prompts/simplicity.md", "utf8");
		// The ladder is the core of the new shape; six rungs, numbered.
		expect(content).toMatch(/## The Decision Procedure/);
		for (const n of [1, 2, 3, 4, 5, 6]) {
			expect(content).toContain(`${n}. **`);
		}
	});

	it("does not duplicate cross-cutting content from shared fragments", async () => {
		// The composer stitches iron-law and grounding-rules (which now
		// also embeds the Quick Self-Check) into every lens. The lens body
		// should NOT re-state their content. This test catches a common
		// regression where the lens prompt grows to duplicate the
		// shared fragments and the prompt balloons.
		const { readFile } = await import("node:fs/promises");
		const content = await readFile("src/prompts/simplicity.md", "utf8");
		// Iron Law: "NEVER suggest fixes before completing risk diagnosis"
		expect(content).not.toContain("NEVER suggest fixes before completing");
		// Grounding: "Code Examination Protocol"
		expect(content).not.toContain("Code Examination Protocol");
		// Grounding: the severity calibration table
		expect(content).not.toMatch(/Critical.*only for exploitable/);
		// Anti-noise rules
		expect(content).not.toContain('Do not flag "missing tests"');
	});

	it("does not re-define the severity tiers (those live in grounding-rules)", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile("src/prompts/simplicity.md", "utf8");
		// Old version had a "Severity Labels" section. The new
		// version defers to the shared grounding-rules fragment.
		expect(content).not.toMatch(/## Severity Labels/);
	});

	it("keeps the lens-specific pattern catalog", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile("src/prompts/simplicity.md", "utf8");
		// These are simplicity-specific catalogs; the shared
		// fragments don't have them. They're the *content* the
		// ladder points to, not a duplication of shared rules.
		expect(content).toContain("Single-use abstractions");
		expect(content).toContain("Spaghetti conditionals");
		expect(content).toContain("Cleverness");
		expect(content).toContain("Surgical Change Check");
	});

	it("ends with output discipline (three questions for a high-signal finding)", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile("src/prompts/simplicity.md", "utf8");
		expect(content).toMatch(/## Output Discipline/);
	});
});

/**
 * Structure tests for the shared grounding fragments. Verifies that
 * synthesis-only calibration rules live in their own file and never leak
 * into the lens grounding file (true separation, not just a scope note).
 */
describe("grounding-rules.md (bundled prompt structure)", () => {
	it("contains the lens grounding and Quick Self-Check sections", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(
			"src/prompts/_shared/grounding-rules.md",
			"utf8",
		);
		expect(content).toContain("### 🔍 Code Examination Protocol");
		expect(content).toContain("### Severity Calibration");
		expect(content).toContain("### Anti-Noise Rules");
		expect(content).toContain("### Quick Self-Check");
	});

	it("does NOT contain synthesis-only rules (no cross-contamination into lenses)", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(
			"src/prompts/_shared/grounding-rules.md",
			"utf8",
		);
		expect(content).not.toContain("### Synthesis Calibration");
		expect(content).not.toContain("You are the final filter");
		expect(content).not.toContain("Merge duplicates across lenses");
	});
});

describe("grounding-rules-synthesis.md (bundled prompt structure)", () => {
	it("contains the synthesis-calibration rules", async () => {
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(
			"src/prompts/_shared/grounding-rules-synthesis.md",
			"utf8",
		);
		expect(content).toContain("## Synthesis Calibration");
		expect(content).toContain("You are the final filter");
		expect(content).toContain("Merge duplicates across lenses");
		expect(content).toContain(
			"Downgrade any maintainability/test/architecture finding labeled critical",
		);
	});
});
