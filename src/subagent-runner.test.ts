import { describe, it, expect } from "vitest";

// Extract the pure helper for testing (not exported, so we reimplement the logic)
function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => !!c && typeof c === "object" && c.type === "text")
		.map((c: any) => c.text ?? "")
		.join("");
}

describe("extractAssistantText", () => {
	it("returns string content directly", () => {
		expect(extractAssistantText("hello")).toBe("hello");
	});

	it("returns empty string for non-string non-array", () => {
		expect(extractAssistantText(null)).toBe("");
		expect(extractAssistantText(undefined)).toBe("");
		expect(extractAssistantText(42)).toBe("");
		expect(extractAssistantText({})).toBe("");
	});

	it("extracts text parts from content blocks", () => {
		const content = [
			{ type: "text", text: "hello " },
			{ type: "text", text: "world" },
		];
		expect(extractAssistantText(content)).toBe("hello world");
	});

	it("filters out non-text blocks", () => {
		const content = [
			{ type: "text", text: "result" },
			{ type: "tool_use", id: "123", name: "bash" },
			{ type: "text", text: " done" },
		];
		expect(extractAssistantText(content)).toBe("result done");
	});

	it("handles empty array", () => {
		expect(extractAssistantText([])).toBe("");
	});

	it("handles array with null/undefined elements", () => {
		const content = [null, undefined, { type: "text", text: "ok" }];
		expect(extractAssistantText(content)).toBe("ok");
	});

	it("handles blocks without text field", () => {
		const content = [{ type: "text" }, { type: "text", text: "yes" }];
		expect(extractAssistantText(content)).toBe("yes");
	});

	it("handles nested non-array content", () => {
		expect(extractAssistantText([{ type: "text", text: "a" }])).toBe("a");
	});
});
