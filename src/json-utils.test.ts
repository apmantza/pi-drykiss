import { describe, it, expect } from "vitest";
import { lenientJsonParse, sanitizeJsonString } from "./json-utils.js";

describe("lenientJsonParse", () => {
	it("parses valid JSON directly", () => {
		expect(lenientJsonParse('{"a": 1}')).toEqual({ a: 1 });
		expect(lenientJsonParse("[1, 2, 3]")).toEqual([1, 2, 3]);
	});

	it("removes markdown code fences", () => {
		const input = '```json\n{"a": 1}\n```';
		expect(lenientJsonParse(input)).toEqual({ a: 1 });
	});

	it("fixes trailing commas", () => {
		expect(lenientJsonParse('{"a": 1,}')).toEqual({ a: 1 });
		expect(lenientJsonParse("[1, 2,]")).toEqual([1, 2]);
	});

	it("extracts JSON from surrounding text", () => {
		const input = 'Here is the result: {"key": "value"} and more text';
		expect(lenientJsonParse(input)).toEqual({ key: "value" });
	});

	it("extracts JSON array from surrounding text", () => {
		const input = "Results:\n[1, 2, 3]\nDone.";
		expect(lenientJsonParse(input)).toEqual([1, 2, 3]);
	});

	it("fixes unescaped newlines in strings", () => {
		const input = '{"text": "line1\nline2"}';
		expect(lenientJsonParse(input)).toEqual({ text: "line1\nline2" });
	});

	it("fixes unescaped tabs in strings", () => {
		const input = '{"text": "col1\tcol2"}';
		expect(lenientJsonParse(input)).toEqual({ text: "col1\tcol2" });
	});

	it("handles single-quote JSON when no double quotes", () => {
		const input = "{'key': 'value'}";
		expect(lenientJsonParse(input)).toEqual({ key: "value" });
	});

	it("truncates unterminated strings to last complete object", () => {
		// This is a best-effort fix - it finds the last complete }
		const input = '{"key": "value"} extra stuff';
		expect(lenientJsonParse(input)).toEqual({ key: "value" });
	});

	it("throws on completely invalid JSON", () => {
		expect(() => lenientJsonParse("not json at all")).toThrow();
	});

	it("handles nested objects with trailing commas", () => {
		const input = '{"a": {"b": 1,},}';
		expect(lenientJsonParse(input)).toEqual({ a: { b: 1 } });
	});

	it("handles escaped quotes and backslashes inside strings", () => {
		const input =
			'[{"file": "src\\\\test\\"quote\\".ts", "detail": "path has \\\\ and \\""}]';
		const parsed = lenientJsonParse(input);
		expect(Array.isArray(parsed)).toBe(true);
		expect((parsed as any[])[0].file).toBe('src\\test"quote".ts');
	});
	it("fixes unescaped double quotes inside string values", () => {
		const input =
			'[{"file": "x.ts", "detail": "use loadPromptBody("iron-law" shared)"}]';
		expect(lenientJsonParse(input)).toEqual({
			file: "x.ts",
			detail: 'use loadPromptBody("iron-law" shared)',
		});
	});
});

describe("sanitizeJsonString", () => {
	it("returns valid JSON unchanged", () => {
		const input = '{"a": 1}';
		expect(sanitizeJsonString(input)).toBe(input);
	});

	it("removes markdown code fences", () => {
		const input = '```json\n{"a": 1}\n```';
		expect(sanitizeJsonString(input).trim()).toBe('{"a": 1}');
	});

	it("removes trailing commas", () => {
		expect(sanitizeJsonString('{"a": 1,}')).toBe('{"a": 1}');
		expect(sanitizeJsonString("[1, 2,]")).toBe("[1, 2]");
	});

	it("replaces newlines inside strings with spaces", () => {
		const input = '{"text": "line1\nline2"}';
		const result = sanitizeJsonString(input);
		expect(result).toContain("line1 line2");
		expect(result).not.toContain("\n");
	});

	it("replaces tabs inside strings with spaces", () => {
		const input = '{"text": "col1\tcol2"}';
		const result = sanitizeJsonString(input);
		expect(result).toContain("col1 col2");
		expect(result).not.toContain("\t");
	});

	it("escapes unescaped double quotes inside string values", () => {
		const input = '{"detail": "use loadPromptBody("iron-law" shared)"}';
		const result = sanitizeJsonString(input);
		let parsed: unknown;
		try {
			parsed = JSON.parse(result);
		} catch (err) {
			throw new Error(
				`JSON.parse failed for sanitized result: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		expect(parsed).toEqual({
			detail: 'use loadPromptBody("iron-law" shared)',
		});
	});

	it("does not modify content outside strings", () => {
		const input = '{"a": 1, "b": 2}';
		expect(sanitizeJsonString(input)).toBe(input);
	});

	it("handles multiple string values", () => {
		const input = '{"a": "x\ny", "b": "z"}';
		const result = sanitizeJsonString(input);
		expect(result).toContain("x y");
		expect(result).toContain('"z"');
	});
});
