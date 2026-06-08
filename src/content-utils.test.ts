import { describe, it, expect } from "vitest";
import { stripAnsi, extractAssistantText } from "./content-utils.js";

describe("stripAnsi", () => {
	it("passes through plain text unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	it("strips SGR color codes", () => {
		const input = "\u001b[31mred\u001b[0m";
		expect(stripAnsi(input)).toBe("red");
	});

	it("strips cursor movement sequences", () => {
		const input = "\u001b[2J\u001b[Hclear";
		expect(stripAnsi(input)).toBe("clear");
	});

	it("strips OSC sequences (hyperlinks)", () => {
		const input = "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007";
		expect(stripAnsi(input)).toBe("link");
	});

	it("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});

	it("handles mixed content with multiple codes", () => {
		const input = "\u001b[1mbold\u001b[22m and \u001b[4munderline\u001b[24m";
		expect(stripAnsi(input)).toBe("bold and underline");
	});
});

describe("extractAssistantText", () => {
	it("extracts text from string content", () => {
		expect(extractAssistantText("plain string")).toBe("plain string");
	});

	it("extracts text from array of text blocks", () => {
		const input = [
			{ type: "text", text: "Hello " },
			{ type: "text", text: "world" },
		];
		expect(extractAssistantText(input)).toBe("Hello world");
	});

	it("skips non-text blocks", () => {
		const input = [
			{ type: "tool_use", text: "tool output" },
			{ type: "text", text: "text only" },
		];
		expect(extractAssistantText(input)).toBe("text only");
	});

	it("returns empty string for non-array, non-string content", () => {
		expect(extractAssistantText(null)).toBe("");
		expect(extractAssistantText(undefined)).toBe("");
		expect(extractAssistantText(42)).toBe("");
		expect(extractAssistantText({})).toBe("");
	});

	it("returns empty string for empty array", () => {
		expect(extractAssistantText([])).toBe("");
	});

	it("handles objects missing text property", () => {
		const input = [{ type: "text" }, { type: "text", text: "works" }];
		expect(extractAssistantText(input)).toBe("works");
	});

	it("handles null items in array", () => {
		const input = [null, { type: "text", text: "survived" }];
		expect(extractAssistantText(input)).toBe("survived");
	});
});
