import { describe, it, expect } from "vitest";
import { buildKissDryInjectionBlock, handleBeforeAgentStart } from "./auto-injector.js";

describe("buildKissDryInjectionBlock", () => {
  it("returns a checklist block with file list", () => {
    const edits = {
      files: [
        { path: "src/app.ts", language: "TypeScript" },
        { path: "src/utils.ts", language: "TypeScript" },
      ],
    };
    const block = buildKissDryInjectionBlock(edits);
    expect(block).toContain("KISS/DRY Quick Check");
    expect(block).toContain("src/app.ts, src/utils.ts");
    expect(block).toContain("KISS");
    expect(block).toContain("DRY");
    expect(block).toContain("Names");
    expect(block).toContain("Size");
    expect(block).toContain("Comments");
    expect(block).toContain("Edge cases");
    expect(block).toContain("Security");
  });

  it("handles single file", () => {
    const block = buildKissDryInjectionBlock({ files: [{ path: "main.py", language: "Python" }] });
    expect(block).toContain("main.py");
  });
});

describe("handleBeforeAgentStart", () => {
  it("injects block into system prompt", () => {
    const event = {
      type: "before_agent_start" as const,
      prompt: "do something",
      systemPrompt: "You are a helpful assistant.",
    };
    const edits = { files: [{ path: "src/app.ts", language: "TypeScript" }], turnIndex: 1 };
    const result = handleBeforeAgentStart(event, edits);
    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain("You are a helpful assistant.");
    expect(result!.systemPrompt).toContain("KISS/DRY Quick Check");
    expect(result!.systemPrompt).toContain("src/app.ts");
  });

  it("returns undefined when no edits", () => {
    const event = {
      type: "before_agent_start" as const,
      prompt: "",
      systemPrompt: "You are a helpful assistant.",
    };
    const result = handleBeforeAgentStart(event, { files: [], turnIndex: 1 });
    expect(result).toBeUndefined();
  });
});
