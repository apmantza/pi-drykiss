import { describe, it, expect } from "vitest";
import { parseFindingsJson } from "./parse-findings.js";

describe("parseFindingsJson", () => {
	describe("canonical contract: bare array", () => {
		it("parses a top-level JSON array of findings", () => {
			const raw = JSON.stringify([
				{
					file: "src/a.ts",
					line: 1,
					severity: "high",
					category: "x",
					summary: "s",
					detail: "d",
					suggestion: "f",
				},
			]);
			const { findings, parseError } = parseFindingsJson(raw, "simplicity");
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
			expect(findings[0].file).toBe("src/a.ts");
		});

		it("parses a top-level JSON array inside a markdown fence", () => {
			const raw =
				"```json\n" +
				JSON.stringify([
					{
						file: "src/a.ts",
						severity: "low",
						category: "c",
						summary: "s",
						detail: "d",
						suggestion: "f",
					},
				]) +
				"\n```";
			const { findings, parseError } = parseFindingsJson(raw);
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
		});

		it("returns empty array when input is empty", () => {
			const { findings } = parseFindingsJson("[]");
			expect(findings).toEqual([]);
		});
	});

	describe("canonical wrapper: { findings: [...] }", () => {
		it("unwraps the canonical findings wrapper", () => {
			const raw = JSON.stringify({
				findings: [
					{
						file: "src/a.ts",
						severity: "high",
						category: "x",
						summary: "s",
						detail: "d",
						suggestion: "f",
					},
				],
			});
			const { findings, parseError } = parseFindingsJson(raw);
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
		});
	});

	describe("LLM drift: alternate wrapper keys", () => {
		// LLM output sometimes wraps findings under a semantically
		// equivalent key. parseFindingsJson must accept the common
		// variants transparently so a drift doesn't silently drop the
		// lens output.

		it.each([
			"results",
			"issues",
			"violations",
			"defects",
			"problems",
			"items",
			"data",
			"output",
			"review",
			"lens_findings",
		])("unwraps an object with a '%s' wrapper key", (key) => {
			const raw = JSON.stringify({
				[key]: [
					{
						file: "src/a.ts",
						severity: "medium",
						category: "x",
						summary: "s",
						detail: "d",
						suggestion: "f",
					},
				],
			});
			const { findings, parseError } = parseFindingsJson(raw);
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
			expect(findings[0].file).toBe("src/a.ts");
		});

		it("prefers 'findings' over other wrapper keys when both are present", () => {
			const raw = JSON.stringify({
				findings: [
					{
						file: "src/canonical.ts",
						severity: "high",
						category: "x",
						summary: "s",
						detail: "d",
						suggestion: "f",
					},
				],
				results: [
					{
						file: "src/wrong.ts",
						severity: "high",
						category: "x",
						summary: "s",
						detail: "d",
						suggestion: "f",
					},
				],
			});
			const { findings } = parseFindingsJson(raw);
			// Canonical 'findings' wins because it's first in the wrapper list.
			expect(findings[0].file).toBe("src/canonical.ts");
		});
	});

	describe("last-ditch recovery: first array property", () => {
		it("picks the first array-typed property when no known wrapper matches", () => {
			// LLM invented a new wrapper key — recover anyway.
			const raw = JSON.stringify({
				lens_output: {
					simplicity_findings: [
						{
							file: "src/a.ts",
							severity: "critical",
							category: "x",
							summary: "s",
							detail: "d",
							suggestion: "f",
						},
					],
				},
			});
			const { findings, parseError } = parseFindingsJson(raw);
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
			expect(findings[0].file).toBe("src/a.ts");
		});

		it("still fails gracefully when the object has no array-typed property", () => {
			const raw = JSON.stringify({ message: "no findings to report" });
			const { findings, parseError } = parseFindingsJson(raw);
			expect(findings).toEqual([]);
			expect(parseError).toContain("Expected array");
		});
	});

	describe("single-object fallback", () => {
		it("wraps a bare finding object in an array", () => {
			const raw = JSON.stringify({
				file: "src/a.ts",
				line: 10,
				severity: "high",
				category: "Bug",
				summary: "Duplicate code",
				detail: "This block is repeated.",
				suggestion: "Extract a helper.",
			});
			const { findings, parseError } = parseFindingsJson(raw, "deduplication");
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
			expect(findings[0].file).toBe("src/a.ts");
			expect(findings[0].severity).toBe("high");
			expect(findings[0].lens).toBe("deduplication");
		});

		it("wraps a bare finding object that omits category", () => {
			const raw = JSON.stringify({
				file: "src/a.ts",
				line: 10,
				severity: "medium",
				summary: "Missing test coverage",
				detail: "No tests for this branch.",
				suggestion: "Add a test.",
			});
			const { findings, parseError } = parseFindingsJson(raw, "tests");
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
			expect(findings[0].file).toBe("src/a.ts");
			expect(findings[0].category).toBe("");
		});

		it("does not treat an unrelated object as a finding", () => {
			const raw = JSON.stringify({ message: "no findings to report" });
			const { findings, parseError } = parseFindingsJson(raw);
			expect(findings).toEqual([]);
			expect(parseError).toContain("Expected array");
		});
	});

	describe("error reporting", () => {
		it("includes the parsed object's key list in the error when it has no array", () => {
			const raw = JSON.stringify({ message: "oops", code: 42 });
			const { parseError } = parseFindingsJson(raw);
			expect(parseError).toContain("object");
			expect(parseError).toContain("message");
			expect(parseError).toContain("code");
		});

		it("mentions the lens in the parse-failure message", () => {
			const raw = "this is not json at all";
			const { parseError } = parseFindingsJson(raw, "resilience");
			expect(parseError).toContain("resilience");
		});

		it("returns a generic message when no lens is given", () => {
			const raw = "this is not json at all";
			const { parseError } = parseFindingsJson(raw);
			expect(parseError).toContain("Failed to parse JSON");
		});
	});

	describe("lenient parsing hooks", () => {
		it("survives unescaped newlines inside string values (sanitized to spaces)", () => {
			// The current sanitizer replaces unescaped \n with a space so
			// the resulting JSON is strictly valid. The original newline
			// is not preserved — but the finding survives, which is what
			// matters for the lens pipeline.
			const raw = `{"findings": [{"file": "src/a.ts", "summary": "line1\nline2", "detail": "d", "suggestion": "f", "category": "c", "severity": "low"}]}`;
			const { findings, parseError } = parseFindingsJson(raw);
			expect(parseError).toBeUndefined();
			expect(findings[0].summary).toBe("line1 line2");
		});

		it("survives trailing commas", () => {
			const raw = `{"findings": [{"file": "src/a.ts", "severity": "low", "category": "c", "summary": "s", "detail": "d", "suggestion": "f",},],}`;
			const { findings, parseError } = parseFindingsJson(raw);
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
		});

		it("survives unescaped double quotes inside string values (docs/code lenses)", () => {
			const raw =
				'[{"file": "src/a.ts", "severity": "medium", "category": "c", "summary": "s", "detail": "use loadPromptBody("iron-law" shared)", "suggestion": "f"}]';
			const { findings, parseError } = parseFindingsJson(raw, "docs");
			expect(parseError).toBeUndefined();
			expect(findings).toHaveLength(1);
			expect(findings[0].detail).toBe('use loadPromptBody("iron-law" shared)');
		});
	});
});
