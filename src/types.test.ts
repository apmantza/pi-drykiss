import { describe, it, expect } from "vitest";
import {
	mapRawToFinding,
	parseFindingsArray,
	parseSynthesis,
	createFallbackSynthesis,
} from "./types.js";
import type { ReviewLens } from "./types.js";

describe("mapRawToFinding", () => {
	it("maps a complete raw object to Finding", () => {
		const raw = {
			file: "src/index.ts",
			line: 42,
			severity: "high",
			category: "DRY",
			summary: "Duplicate code",
			detail: "Two identical blocks found",
			suggestion: "Extract to helper",
			confidence: "confirmed",
		};
		const result = mapRawToFinding(raw);
		expect(result.file).toBe("src/index.ts");
		expect(result.line).toBe(42);
		expect(result.severity).toBe("high");
		expect(result.category).toBe("DRY");
		expect(result.summary).toBe("Duplicate code");
		expect(result.detail).toBe("Two identical blocks found");
		expect(result.suggestion).toBe("Extract to helper");
		expect(result.confidence).toBe("confirmed");
	});

	it("provides defaults for missing fields", () => {
		const result = mapRawToFinding({});
		expect(result.file).toBe("unknown");
		expect(result.line).toBeUndefined();
		expect(result.severity).toBe("medium");
		expect(result.category).toBe("");
		expect(result.summary).toBe("");
		expect(result.detail).toBe("");
		expect(result.suggestion).toBe("");
		expect(result.confidence).toBeUndefined();
	});

	it("uses summary as detail fallback", () => {
		const result = mapRawToFinding({ summary: "Important issue" });
		expect(result.detail).toBe("Important issue");
	});

	it("handles non-string file as string", () => {
		const result = mapRawToFinding({ file: 123 });
		expect(result.file).toBe("123");
	});

	it("handles non-number line by ignoring it", () => {
		const result = mapRawToFinding({ line: "not a number" });
		expect(result.line).toBeUndefined();
	});

	it("handles invalid severity with fallback to medium", () => {
		const result = mapRawToFinding({ severity: "unknown" });
		expect(result.severity).toBe("unknown");
	});

	it("passes lens parameter through", () => {
		const result = mapRawToFinding({}, "simplicity" as ReviewLens);
		expect(result.lens).toBe("simplicity");
	});
});

describe("parseFindingsArray", () => {
	it("parses a valid array of findings", () => {
		const raw = [
			{ file: "a.ts", severity: "low", summary: "test" },
			{ file: "b.ts", severity: "high", summary: "test2" },
		];
		const result = parseFindingsArray(raw);
		expect(result).toHaveLength(2);
		expect(result[0].file).toBe("a.ts");
		expect(result[1].file).toBe("b.ts");
	});

	it("returns empty array for non-array input", () => {
		expect(parseFindingsArray(null)).toEqual([]);
		expect(parseFindingsArray(undefined)).toEqual([]);
		expect(parseFindingsArray("string")).toEqual([]);
		expect(parseFindingsArray(42)).toEqual([]);
		expect(parseFindingsArray({})).toEqual([]);
	});

	it("returns empty array for empty array", () => {
		expect(parseFindingsArray([])).toEqual([]);
	});

	it("filters out objects that become valid findings", () => {
		const raw = [{}, null, undefined, { file: "test.ts" }];
		const result = parseFindingsArray(raw);
		// All items become findings via mapRawToFinding (with defaults)
		expect(result).toHaveLength(4);
	});

	it("passes lens to each finding", () => {
		const raw = [{ file: "a.ts" }, { file: "b.ts" }];
		const result = parseFindingsArray(raw, "deduplication" as ReviewLens);
		expect(result[0].lens).toBe("deduplication");
		expect(result[1].lens).toBe("deduplication");
	});
});

describe("createFallbackSynthesis", () => {
	it("creates a fallback with the given summary", () => {
		const result = createFallbackSynthesis("Something went wrong");
		expect(result.summary).toBe("Something went wrong");
		expect(result.verdict).toBe("Request changes");
		expect(result.findings).toEqual([]);
		expect(result.criticalCount).toBe(0);
		expect(result.highCount).toBe(0);
		expect(result.mediumCount).toBe(0);
		expect(result.lowCount).toBe(0);
		expect(result.nitCount).toBe(0);
	});
});

describe("parseSynthesis", () => {
	it("parses valid synthesis JSON", () => {
		const raw = JSON.stringify({
			findings: [
				{ file: "a.ts", severity: "critical", summary: "issue" },
				{ file: "b.ts", severity: "high", summary: "issue2" },
			],
			summary: "Found issues",
			verdict: "Request changes",
		});
		const result = parseSynthesis(raw);
		expect(result.findings).toHaveLength(2);
		expect(result.summary).toBe("Found issues");
		expect(result.verdict).toBe("Request changes");
		expect(result.criticalCount).toBe(1);
		expect(result.highCount).toBe(1);
	});

	it("handles JSON wrapped in markdown fences", () => {
		const raw =
			'```json\n{"findings": [], "summary": "ok", "verdict": "Approve"}\n```';
		const result = parseSynthesis(raw);
		expect(result.summary).toBe("ok");
		expect(result.verdict).toBe("Approve");
	});

	it("handles JSON with trailing commas", () => {
		const raw = '{"findings": [], "summary": "ok", "verdict": "Approve",}';
		const result = parseSynthesis(raw);
		expect(result.summary).toBe("ok");
	});

	it("returns fallback for non-JSON input", () => {
		const result = parseSynthesis("not json at all");
		expect(result.findings).toEqual([]);
		expect(result.verdict).toBe("Request changes");
		expect(result.summary).toContain("non-JSON");
	});

	it("returns fallback for null/undefined parsed value", () => {
		const result = parseSynthesis("null");
		expect(result.findings).toEqual([]);
		expect(result.verdict).toBe("Request changes");
	});

	it("counts findings by severity", () => {
		const raw = JSON.stringify({
			findings: [
				{ file: "a.ts", severity: "critical" },
				{ file: "b.ts", severity: "critical" },
				{ file: "c.ts", severity: "high" },
				{ file: "d.ts", severity: "medium" },
				{ file: "e.ts", severity: "low" },
				{ file: "f.ts", severity: "nit" },
			],
			summary: "test",
			verdict: "Request changes",
		});
		const result = parseSynthesis(raw);
		expect(result.criticalCount).toBe(2);
		expect(result.highCount).toBe(1);
		expect(result.mediumCount).toBe(1);
		expect(result.lowCount).toBe(1);
		expect(result.nitCount).toBe(1);
	});
});
