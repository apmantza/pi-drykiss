import { describe, it, expect } from "vitest";
import {
	mapRawToFinding,
	parseFindingsArray,
	parseSynthesis,
	createFallbackSynthesis,
	computeHealthScore,
	severityToTier,
} from "./types.js";
import type { ReviewLens, Finding } from "./types.js";

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
		expect(result.severity).toBe("medium");
	});

	it("normalizes priority tags", () => {
		expect(mapRawToFinding({ priority: "p1" }).priority).toBe("P1");
		expect(mapRawToFinding({ priority: "P0" }).priority).toBe("P0");
	});

	it("drops invalid priority values", () => {
		expect(mapRawToFinding({ priority: "urgent" }).priority).toBeUndefined();
	});

	it("passes lens parameter through", () => {
		const result = mapRawToFinding({}, "simplicity" as ReviewLens);
		expect(result.lens).toBe("simplicity");
	});
});

describe("mapRawToFinding — consequence/source/riskCode", () => {
	it("coerces provided consequence and source to non-empty strings", () => {
		const result = mapRawToFinding({
			file: "src/a.ts",
			consequence: "A test will fail next time.",
			source: "helper foo()",
		});
		expect(result.consequence).toBe("A test will fail next time.");
		expect(result.source).toBe("helper foo()");
	});

	it("uses undefined for missing consequence and source", () => {
		const result = mapRawToFinding({ file: "src/a.ts" });
		expect(result.consequence).toBeUndefined();
		expect(result.source).toBeUndefined();
	});

	it("uses undefined for empty-string consequence and source (not '')", () => {
		const result = mapRawToFinding({
			file: "src/a.ts",
			consequence: "",
			source: "",
		});
		expect(result.consequence).toBeUndefined();
		expect(result.source).toBeUndefined();
	});

	it("passes through a riskCode when provided", () => {
		const result = mapRawToFinding({ file: "src/a.ts", riskCode: "R1" });
		expect(result.riskCode).toBe("R1");
	});

	it("defaults riskCode to undefined when not provided", () => {
		const result = mapRawToFinding({ file: "src/a.ts" });
		expect(result.riskCode).toBeUndefined();
	});

	it("passes through valid action and riskLevel", () => {
		const result = mapRawToFinding({
			file: "src/a.ts",
			action: "discuss",
			riskLevel: "high",
		});
		expect(result.action).toBe("discuss");
		expect(result.riskLevel).toBe("high");
	});

	it("ignores invalid action and riskLevel values", () => {
		const result = mapRawToFinding({
			file: "src/a.ts",
			action: "maybe",
			riskLevel: "critical",
		});
		expect(result.action).toBeUndefined();
		expect(result.riskLevel).toBeUndefined();
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

describe("computeHealthScore", () => {
	it("returns 100 for zero findings", () => {
		const result = computeHealthScore([]);
		expect(result.score).toBe(100);
		expect(result.breakdown).toEqual({
			critical: 0,
			warning: 0,
			suggestion: 0,
		});
	});

	it("deducts 15 per critical finding", () => {
		const findings = [
			{ severity: "critical" } as Finding,
			{ severity: "critical" } as Finding,
		];
		const result = computeHealthScore(findings);
		expect(result.score).toBe(70);
		expect(result.breakdown.critical).toBe(2);
	});

	it("deducts 5 per warning (high/medium) finding", () => {
		const findings = [
			{ severity: "high" } as Finding,
			{ severity: "medium" } as Finding,
		];
		const result = computeHealthScore(findings);
		expect(result.score).toBe(90);
		expect(result.breakdown.warning).toBe(2);
	});

	it("deducts 1 per suggestion (low/nit) finding", () => {
		const findings = [
			{ severity: "low" } as Finding,
			{ severity: "nit" } as Finding,
		];
		const result = computeHealthScore(findings);
		expect(result.score).toBe(98);
		expect(result.breakdown.suggestion).toBe(2);
	});

	it("floors at 0 with many critical findings", () => {
		const findings = new Array(10)
			.fill(null)
			.map(() => ({ severity: "critical" }) as Finding);
		const result = computeHealthScore(findings);
		expect(result.score).toBe(0);
	});

	it("combines all tiers correctly", () => {
		const findings = [
			{ severity: "critical" } as Finding,
			{ severity: "high" } as Finding,
			{ severity: "medium" } as Finding,
			{ severity: "low" } as Finding,
		];
		const result = computeHealthScore(findings);
		// 100 - 15 - 5 - 5 - 1 = 74
		expect(result.score).toBe(74);
		expect(result.breakdown).toEqual({
			critical: 1,
			warning: 2,
			suggestion: 1,
		});
	});
});

describe("severityToTier", () => {
	it("maps critical → critical", () => {
		expect(severityToTier("critical")).toBe("critical");
	});
	it("maps high → warning", () => {
		expect(severityToTier("high")).toBe("warning");
	});
	it("maps medium → warning", () => {
		expect(severityToTier("medium")).toBe("warning");
	});
	it("maps low → suggestion", () => {
		expect(severityToTier("low")).toBe("suggestion");
	});
	it("maps nit → suggestion", () => {
		expect(severityToTier("nit")).toBe("suggestion");
	});
});

describe("parseSynthesis — mermaidGraph", () => {
	it("extracts mermaidGraph when present", () => {
		const raw = JSON.stringify({
			findings: [],
			summary: "ok",
			verdict: "Approve",
			mermaidGraph: "graph TD\n  A[a.ts]\n  B[b.ts]",
		});
		const result = parseSynthesis(raw);
		expect(result.mermaidGraph).toBe("graph TD\n  A[a.ts]\n  B[b.ts]");
	});

	it("omits mermaidGraph when absent", () => {
		const raw = JSON.stringify({
			findings: [],
			summary: "ok",
			verdict: "Approve",
		});
		const result = parseSynthesis(raw);
		expect(result.mermaidGraph).toBeUndefined();
	});

	it("omits mermaidGraph when empty string", () => {
		const raw = JSON.stringify({
			findings: [],
			summary: "ok",
			verdict: "Approve",
			mermaidGraph: "",
		});
		const result = parseSynthesis(raw);
		expect(result.mermaidGraph).toBeUndefined();
	});

	it("omits mermaidGraph when whitespace only", () => {
		const raw = JSON.stringify({
			findings: [],
			summary: "ok",
			verdict: "Approve",
			mermaidGraph: "   ",
		});
		const result = parseSynthesis(raw);
		expect(result.mermaidGraph).toBeUndefined();
	});
});

describe("createFallbackSynthesis — mermaidGraph", () => {
	it("omits mermaidGraph in fallback (no graph available)", () => {
		const result = createFallbackSynthesis("error");
		expect(result.mermaidGraph).toBeUndefined();
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

	it("parses optional synthesis fields", () => {
		const raw = JSON.stringify({
			findings: [],
			summary: "ok",
			verdict: "Approve",
			files: [{ path: "src/foo.ts", role: "read", description: "reviewed" }],
			nextSteps: ["add integration test"],
			notDone: [{ item: "bench", reason: "out of scope" }],
			extensions: { mermaidGraph: "graph TD" },
		});
		const result = parseSynthesis(raw);
		expect(result.files).toHaveLength(1);
		expect(result.files?.[0].path).toBe("src/foo.ts");
		expect(result.nextSteps).toEqual(["add integration test"]);
		expect(result.notDone).toHaveLength(1);
		expect(result.extensions).toEqual({ mermaidGraph: "graph TD" });
	});

	it("overrides a non-approving verdict to Approve when findings are empty", () => {
		const raw = JSON.stringify({
			findings: [],
			summary: "",
			verdict: "Needs security review",
		});
		const result = parseSynthesis(raw);
		expect(result.verdict).toBe("Approve");
		expect(result.summary).toBe("No issues found");
		expect(result.findings).toEqual([]);
	});

	it("preserves a non-approving verdict when findings are present", () => {
		const raw = JSON.stringify({
			findings: [{ file: "a.ts", severity: "high", summary: "issue" }],
			summary: "Found an issue",
			verdict: "Needs security review",
		});
		const result = parseSynthesis(raw);
		expect(result.verdict).toBe("Needs security review");
		expect(result.summary).toBe("Found an issue");
	});
});
