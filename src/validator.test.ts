import { describe, expect, it, vi } from "vitest";
import * as promptLoader from "./prompt-loader.js";
import {
	applyValidatorVerdicts,
	buildValidatorUserPrompt,
	loadValidatorSystemPrompt,
	parseValidatorOutput,
	runValidator,
	selectFindingsForValidation,
	type ValidatorVerdict,
} from "./validator.js";
import type { Finding } from "./types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/a.ts",
		line: 10,
		severity: "medium",
		category: "Bug",
		summary: "Some issue",
		detail: "Detail",
		suggestion: "Fix it",
		...overrides,
	};
}

describe("buildValidatorUserPrompt", () => {
	it("returns empty string for no findings", () => {
		expect(buildValidatorUserPrompt([])).toBe("");
	});

	it("numbers each finding starting from 0", () => {
		const findings = [
			finding({ file: "src/a.ts", line: 1 }),
			finding({ file: "src/b.ts", line: 2, severity: "high" }),
		];
		const prompt = buildValidatorUserPrompt(findings);
		expect(prompt).toContain("[0] (medium)");
		expect(prompt).toContain("[1] (high)");
	});

	it("includes the file:line and file-only locations", () => {
		const findings = [
			finding({ file: "src/a.ts", line: 1 }),
			finding({ file: "src/b.ts" }),
		];
		const prompt = buildValidatorUserPrompt(findings);
		expect(prompt).toContain("src/a.ts:1");
		expect(prompt).toMatch(/\[1\] \(medium\) src\/b\.ts(?!\d)/);
	});

	it("includes the lens tag when present", () => {
		const findings = [finding({ lens: "security" })];
		const prompt = buildValidatorUserPrompt(findings);
		expect(prompt).toContain("(lens: security)");
	});

	it("omits the lens tag when missing", () => {
		const findings = [finding({ lens: undefined })];
		const prompt = buildValidatorUserPrompt(findings);
		expect(prompt).not.toContain("(lens:");
	});

	it("omits detail/suggestion when missing", () => {
		const findings = [finding({ detail: "", suggestion: "" })];
		const prompt = buildValidatorUserPrompt(findings);
		expect(prompt).not.toContain("Detail:");
		expect(prompt).not.toContain("Suggestion:");
	});
});

describe("parseValidatorOutput", () => {
	it("parses a clean JSON array", () => {
		const text = JSON.stringify([
			{ id: 0, verdict: "real", confidence: 0.9, justification: "x" },
			{ id: 1, verdict: "false-positive", confidence: 0.6 },
		]);
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get(0)?.verdict).toBe("real");
		expect(verdicts.get(1)?.verdict).toBe("false-positive");
		expect(verdicts.get(0)?.justification).toBe("x");
	});

	it("tolerates ```json fences around the array", () => {
		const text =
			"```json\n" +
			JSON.stringify([{ id: 0, verdict: "real", confidence: 0.9 }]) +
			"\n```";
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get(0)?.verdict).toBe("real");
	});

	it("tolerates leading prose before the array", () => {
		const text =
			"Here is my verdict:\n\n" +
			JSON.stringify([{ id: 0, verdict: "real", confidence: 0.9 }]);
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.size).toBe(1);
	});

	it("clamps confidence to [0, 1]", () => {
		const text = JSON.stringify([
			{ id: 0, verdict: "real", confidence: 1.5 },
			{ id: 1, verdict: "real", confidence: -0.2 },
		]);
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.get(0)?.confidence).toBe(1);
		expect(verdicts.get(1)?.confidence).toBe(0);
	});

	it("defaults confidence to 0.5 when missing or invalid", () => {
		const text = JSON.stringify([
			{ id: 0, verdict: "real" },
			{ id: 1, verdict: "real", confidence: "not-a-number" },
		]);
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.get(0)?.confidence).toBe(0.5);
		expect(verdicts.get(1)?.confidence).toBe(0.5);
	});

	it("returns empty map for non-array JSON", () => {
		expect(parseValidatorOutput('{"id": 0, "verdict": "real"}').size).toBe(0);
	});

	it("returns empty map for unparseable text", () => {
		expect(parseValidatorOutput("not json").size).toBe(0);
	});

	it("returns empty map when no array is present", () => {
		expect(parseValidatorOutput("just some text").size).toBe(0);
	});

	it("skips entries with non-integer or missing id", () => {
		const text = JSON.stringify([
			{ id: 0, verdict: "real", confidence: 0.9 },
			{ verdict: "real", confidence: 0.9 }, // no id
			{ id: "0", verdict: "real", confidence: 0.9 }, // string id
			{ id: 1.5, verdict: "real", confidence: 0.9 }, // non-integer
		]);
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.size).toBe(1);
		expect(verdicts.has(0)).toBe(true);
	});

	it("skips entries with invalid verdict strings", () => {
		const text = JSON.stringify([
			{ id: 0, verdict: "real", confidence: 0.9 },
			{ id: 1, verdict: "maybe", confidence: 0.9 },
		]);
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.size).toBe(1);
		expect(verdicts.has(0)).toBe(true);
	});

	it("drops empty justification strings", () => {
		const text = JSON.stringify([
			{ id: 0, verdict: "real", confidence: 0.9, justification: "   " },
		]);
		const verdicts = parseValidatorOutput(text);
		expect(verdicts.get(0)?.justification).toBeUndefined();
	});
});

describe("applyValidatorVerdicts", () => {
	it("tags findings with their verdict", () => {
		const findings = [finding(), finding({ file: "b.ts" })];
		const verdicts = new Map<number, ValidatorVerdict>([
			[0, { id: 0, verdict: "real", confidence: 0.9, justification: "x" }],
			[1, { id: 1, verdict: "false-positive", confidence: 0.7 }],
		]);
		const out = applyValidatorVerdicts(findings, verdicts);
		expect(out[0]._validatorVerdict).toBe("real");
		expect(out[0]._validatorJustification).toBe("x");
		expect(out[1]._validatorVerdict).toBe("false-positive");
	});

	it("tags findings without a verdict as 'unverified'", () => {
		const findings = [finding(), finding({ file: "b.ts" })];
		const verdicts = new Map<number, ValidatorVerdict>([
			[0, { id: 0, verdict: "real", confidence: 0.9 }],
		]);
		const out = applyValidatorVerdicts(findings, verdicts);
		expect(out[0]._validatorVerdict).toBe("real");
		expect(out[1]._validatorVerdict).toBe("unverified");
	});

	it("never returns a shorter list (all input findings annotated)", () => {
		const findings = [finding(), finding(), finding()];
		const verdicts = new Map<number, ValidatorVerdict>(); // empty
		const out = applyValidatorVerdicts(findings, verdicts);
		expect(out).toHaveLength(3);
		expect(out.every((f) => f._validatorVerdict === "unverified")).toBe(true);
	});

	it("returns empty for empty input", () => {
		expect(applyValidatorVerdicts([], new Map())).toEqual([]);
	});

	it("preserves the rest of the finding's fields", () => {
		const f = finding({
			file: "src/x.ts",
			line: 99,
			severity: "critical",
			summary: "A real bug",
		});
		const verdicts = new Map<number, ValidatorVerdict>([
			[0, { id: 0, verdict: "real", confidence: 0.9 }],
		]);
		const out = applyValidatorVerdicts([f], verdicts);
		expect(out[0].file).toBe("src/x.ts");
		expect(out[0].line).toBe(99);
		expect(out[0].severity).toBe("critical");
		expect(out[0].summary).toBe("A real bug");
		expect(out[0]._validatorVerdict).toBe("real");
	});
});

describe("selectFindingsForValidation", () => {
	it("selects blockers and weakly grounded findings only", () => {
		const selected = selectFindingsForValidation([
			finding({ severity: "critical" }),
			finding({ severity: "high" }),
			finding({ severity: "medium", confidence: "suspect" }),
			finding({ severity: "medium" }),
			finding({ severity: "medium", confidence: "confirmed" }),
			finding({ severity: "medium", confidence: "likely" }),
			finding({ severity: "low", _suppressed: true }),
			finding({ severity: "low", _previouslyRejected: true }),
		]);
		expect(selected).toHaveLength(4);
		expect(selected.map((item) => item.severity)).toEqual([
			"critical",
			"high",
			"medium",
			"medium",
		]);
	});
});


describe("runValidator — fail-open behavior", () => {
	function ctx(): {
		ui: { notify: (msg: string, level: string) => void };
		modelRegistry: {
			getAvailable: () => never[];
			getApiKeyAndHeaders: () => Promise<never>;
		};
		hasUI: boolean;
	} {
		return {
			ui: { notify: () => {} },
			modelRegistry: {
				getAvailable: () => [],
				getApiKeyAndHeaders: () => Promise.reject(new Error("no model")),
			},
			hasUI: false,
		};
	}

	it("returns empty result for empty input without calling the model", async () => {
		const result = await runValidator(ctx() as never, [], "diff");
		expect(result.findings).toEqual([]);
		expect(result.droppedFalsePositives).toBe(0);
		expect(result.confirmedReal).toBe(0);
		expect(result.unverified).toBe(0);
	});

	it("fails open when the LLM call errors: every finding becomes 'unverified'", async () => {
		// No model available → callLLM will throw. The validator must
		// surface findings unchanged, marked unverified, never dropped.
		const findings = [finding(), finding({ file: "b.ts" })];
		const result = await runValidator(ctx() as never, findings, "diff");
		expect(result.findings).toHaveLength(2);
		expect(
			result.findings.every((f) => f._validatorVerdict === "unverified"),
		).toBe(true);
		expect(result.unverified).toBe(2);
		expect(result.droppedFalsePositives).toBe(0);
		expect(result.confirmedReal).toBe(0);
		expect(result.errorMessage).toBeDefined();
	});

	it("fails open when the validator prompt fails to load: findings become 'unverified'", async () => {
		const spy = vi
			.spyOn(promptLoader, "loadPromptBody")
			.mockRejectedValue(new Error("missing validator.md"));
		try {
			const findings = [finding(), finding({ file: "b.ts" })];
			const result = await runValidator(ctx() as never, findings, "diff");
			expect(result.findings).toHaveLength(2);
			expect(
				result.findings.every((f) => f._validatorVerdict === "unverified"),
			).toBe(true);
			expect(result.unverified).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("loadValidatorSystemPrompt", () => {
	it("resolves the bundled validator.md by default", async () => {
		const prompt = await loadValidatorSystemPrompt();
		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(0);
		// The bundled validator.md opens with an H1 title.
		expect(prompt).toContain("# Validator");
	});

	it("delegates to loadPromptBody (user dir → bundled)", async () => {
		const spy = vi
			.spyOn(promptLoader, "loadPromptBody")
			.mockResolvedValue("CUSTOM VALIDATOR PROMPT");
		try {
			const prompt = await loadValidatorSystemPrompt();
			expect(prompt).toBe("CUSTOM VALIDATOR PROMPT");
			expect(spy).toHaveBeenCalledWith("validator", "shared");
		} finally {
			spy.mockRestore();
		}
	});

	it("propagates errors when loadPromptBody fails (no file)", async () => {
		const spy = vi
			.spyOn(promptLoader, "loadPromptBody")
			.mockRejectedValue(new Error("missing validator.md"));
		try {
			await expect(loadValidatorSystemPrompt()).rejects.toThrow(
				"missing validator.md",
			);
		} finally {
			spy.mockRestore();
		}
	});
});
