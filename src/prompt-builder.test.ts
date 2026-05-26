import { describe, it, expect } from "vitest";
import { buildReviewPrompts, buildSynthesisPrompt, buildAutoInjectBlock } from "./prompt-builder.js";
import type { ChangedFile } from "./types.js";

const mockFiles: ChangedFile[] = [
  { path: "src/app.ts", status: "modified", language: "TypeScript" },
  { path: "src/utils.ts", status: "added", language: "TypeScript" },
];

const mockDiffs = new Map<string, string>([
  ["src/app.ts", "@@ -1,2 +1,3 @@\n+console.log('hello')"],
  ["src/utils.ts", "@@ -0,0 +1,2 @@\n+export const x = 1"],
]);

describe("buildReviewPrompts", () => {
  it("returns single prompt for simplicity lens", async () => {
    const prompts = await buildReviewPrompts(mockFiles, mockDiffs, "simplicity");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].lens).toBe("simplicity");
    expect(prompts[0].systemPrompt).toContain("Simplicity Auditor");
    expect(prompts[0].systemPrompt).toContain("KISS");
    expect(prompts[0].userPrompt).toContain("src/app.ts");
    expect(prompts[0].userPrompt).toContain("src/utils.ts");
  });

  it("returns single prompt for deduplication lens", async () => {
    const prompts = await buildReviewPrompts(mockFiles, mockDiffs, "deduplication");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].lens).toBe("deduplication");
    expect(prompts[0].systemPrompt).toContain("Duplication Hunter");
    expect(prompts[0].systemPrompt).toContain("DRY");
  });

  it("returns single prompt for clarity lens", async () => {
    const prompts = await buildReviewPrompts(mockFiles, mockDiffs, "clarity");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].lens).toBe("clarity");
    expect(prompts[0].systemPrompt).toContain("Clarity & Quality Auditor");
    expect(prompts[0].systemPrompt).toContain("Security Check");
    expect(prompts[0].systemPrompt).toContain("Performance Check");
  });

  it("returns all three prompts for 'all' lens", async () => {
    const prompts = await buildReviewPrompts(mockFiles, mockDiffs, "all");
    expect(prompts).toHaveLength(3);
    const lenses = prompts.map((p) => p.lens);
    expect(lenses).toContain("simplicity");
    expect(lenses).toContain("deduplication");
    expect(lenses).toContain("clarity");
  });

  it("includes diff content in user prompt", async () => {
    const prompts = await buildReviewPrompts(mockFiles, mockDiffs, "simplicity");
    expect(prompts[0].userPrompt).toContain("console.log('hello')");
    expect(prompts[0].userPrompt).toContain("export const x = 1");
  });

  it("handles missing diffs gracefully", async () => {
    const emptyDiffs = new Map<string, string>();
    const prompts = await buildReviewPrompts(mockFiles, emptyDiffs, "simplicity");
    expect(prompts[0].userPrompt).toContain("(diff not available)");
  });

  it("requires JSON output in system prompts", async () => {
    const prompts = await buildReviewPrompts(mockFiles, mockDiffs, "simplicity");
    expect(prompts[0].systemPrompt).toContain("Output findings as a single JSON array");
    expect(prompts[0].systemPrompt).toContain("Output ONLY the JSON array");
  });
});

describe("buildSynthesisPrompt", () => {
  it("returns system and user prompts", () => {
    const result = buildSynthesisPrompt([
      { lens: "simplicity", rawOutput: "[{\"file\":\"a.ts\",\"severity\":\"high\"}]" },
      { lens: "deduplication", rawOutput: "[{\"file\":\"b.ts\",\"severity\":\"medium\"}]" },
    ]);
    expect(result.systemPrompt).toContain("Senior Engineer Synthesizer");
    expect(result.systemPrompt).toContain("critical > high > medium > low > nit");
    expect(result.systemPrompt).toContain("Output the final report as a single JSON object");
    expect(result.userPrompt).toContain("SIMPLICITY REVIEWER");
    expect(result.userPrompt).toContain("DEDUPLICATION REVIEWER");
  });
});

describe("buildAutoInjectBlock", () => {
  it("returns null when no files", () => {
    const block = buildAutoInjectBlock({ files: [] });
    expect(block).toContain("KISS/DRY Quick Check");
    expect(block).toContain("You edited:");
  });

  it("lists edited files", () => {
    const block = buildAutoInjectBlock({
      files: [
        { path: "src/a.ts", language: "TypeScript" },
        { path: "src/b.ts", language: "TypeScript" },
      ],
    });
    expect(block).toContain("src/a.ts, src/b.ts");
    expect(block).toContain("Is the new code as simple as the problem allows?");
    expect(block).toContain("Is knowledge represented once?");
    expect(block).toContain("Do variables/functions reveal intent");
    expect(block).toContain("Are functions focused on one thing?");
    expect(block).toContain("Do they explain WHY, not WHAT?");
    expect(block).toContain("Edge cases");
    expect(block).toContain("Security");
  });
});
