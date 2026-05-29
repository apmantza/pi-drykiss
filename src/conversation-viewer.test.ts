import { describe, it, expect } from "vitest";
import { chunkLine } from "./conversation-viewer.js";

describe("chunkLine", () => {
	it("returns single chunk for short text", () => {
		expect(chunkLine("hello", 80)).toEqual(["hello"]);
	});

	it("returns empty array for empty string", () => {
		expect(chunkLine("", 80)).toEqual([]);
	});

	it("splits text into chunks of max length", () => {
		const result = chunkLine("abcdefghij", 4);
		expect(result).toEqual(["abcd", "efgh", "ij"]);
	});

	it("splits on newlines by replacing them with spaces", () => {
		const result = chunkLine("line1\nline2\nline3", 20);
		expect(result).toEqual(["line1 line2 line3"]);
	});

	it("handles text exactly at max length", () => {
		const result = chunkLine("12345", 5);
		expect(result).toEqual(["12345"]);
	});

	it("handles single character max", () => {
		const result = chunkLine("abc", 1);
		expect(result).toEqual(["a", "b", "c"]);
	});

	it("preserves content when splitting long text with newlines", () => {
		const text = "First line is quite long\nSecond line";
		const result = chunkLine(text, 20);
		// Newlines replaced with spaces, then split at max
		const joined = result.join("");
		expect(joined).toContain("First line is quite long");
		expect(joined).toContain("Second line");
	});
});
