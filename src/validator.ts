/**
 * Validator stage — adversarial falsification pass over synthesized findings.
 *
 * Pipeline position: lenses → synthesis → **validate** → score/render.
 *
 * The validator runs a separate LLM call whose system prompt is sourced
 * from `src/prompts/_shared/validator.md` and whose user prompt lists the
 * synthesized findings plus the diff. The LLM returns a JSON array of
 * per-finding verdicts ("real" or "false-positive" + a confidence and a
 * one-sentence justification).
 *
 * Design notes:
 *   - "Fail open": if the validator errors or returns no parseable output,
 *     every finding is tagged `_validatorVerdict: "unverified"` and surfaced
 *     unchanged. A flaky model never silently drops a real finding.
 *   - The validator is opt-in. Default `/drykiss` flow runs without it to
 *     keep the existing cost/latency budget. Enable with `--validate` or
 *     `config.validate: true` in `.pi/drykiss/config.json`.
 *   - Findings tagged "false-positive" are NOT removed from the rendered
 *     list. They get a visible `[✗ false positive]` tag and are downranked
 *     to the bottom so the user can see and override the validator's
 *     judgment — the same "never hide" principle as the rejection store.
 */

import { extractBalancedJsonArray } from "./json-extract.js";
import { callLLM } from "./llm.js";
import { bundledPromptsDir } from "./prompt-loader.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Finding } from "./types.js";
import { LOG_PREFIX } from "./constants.js";

/** A single validator verdict for one candidate finding. */
export interface ValidatorVerdict {
	readonly id: number;
	readonly verdict: "real" | "false-positive";
	/** Float in [0, 1]. Higher = more confident. */
	readonly confidence: number;
	readonly justification?: string;
}

/** Outcome of the validator stage. Always includes every input finding. */
export interface ValidatorResult {
	/** Findings annotated with `_validatorVerdict` + optional justification. */
	readonly findings: Finding[];
	/** Number of findings the validator marked "false-positive". */
	readonly droppedFalsePositives: number;
	/** Number of findings the validator marked "real". */
	readonly confirmedReal: number;
	/**
	 * Number of findings left as "unverified" because the validator
	 * errored, returned no parseable output, or could not conclude.
	 */
	readonly unverified: number;
	/** Best-effort error message when the validator itself failed. */
	readonly errorMessage?: string;
}

/**
 * Build the user prompt for the validator: a numbered list of findings
 * (file, line, severity, category, summary, detail, suggestion, lens)
 * with a header reminding the LLM of its falsification job. Pure.
 */
export function buildValidatorUserPrompt(findings: readonly Finding[]): string {
	if (findings.length === 0) return "";
	const header =
		"# Candidate Findings to Validate\n\n" +
		"For each numbered finding below, return a JSON object with: " +
		'`id` (the number), `verdict` ("real" or "false-positive"), ' +
		"`confidence` (0.0–1.0), and `justification` (one or two sentences).\n\n";
	const list = findings
		.map((f, index) => {
			const where = f.line ? `${f.file}:${f.line}` : f.file;
			const lens = f.lens ? ` (lens: ${f.lens})` : "";
			const lines = [
				`[${index}] (${f.severity})${lens} ${where}`,
				`  Summary: ${f.summary}`,
				f.detail ? `  Detail: ${f.detail}` : "",
				f.suggestion ? `  Suggestion: ${f.suggestion}` : "",
			].filter(Boolean);
			return lines.join("\n");
		})
		.join("\n\n");
	return `${header}${list}\n\nReturn ONLY the JSON array described in your instructions.`;
}

/**
 * Parse the validator's raw text output into a Map<id, verdict>. Tolerates
 * a JSON array wrapped in markdown fences or surrounded by prose. Pure.
 */
export function parseValidatorOutput(
	text: string,
): Map<number, ValidatorVerdict> {
	const json = extractBalancedJsonArray(text);
	if (!json) return new Map();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return new Map();
	}
	if (!Array.isArray(parsed)) return new Map();
	const verdicts = new Map<number, ValidatorVerdict>();
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.id !== "number" || !Number.isInteger(record.id)) continue;
		let verdict: "real" | "false-positive" | null;
		if (record.verdict === "real") {
			verdict = "real";
		} else if (record.verdict === "false-positive") {
			verdict = "false-positive";
		} else {
			verdict = null;
		}
		if (!verdict) continue;
		const confidence =
			typeof record.confidence === "number" &&
			Number.isFinite(record.confidence)
				? Math.min(1, Math.max(0, record.confidence))
				: 0.5;
		const justification =
			typeof record.justification === "string"
				? record.justification.trim() || undefined
				: undefined;
		verdicts.set(record.id, {
			id: record.id,
			verdict,
			confidence,
			justification,
		});
	}
	return verdicts;
}

/**
 * Apply verdicts to a findings list. Each verdict maps to a finding by
 * its index in the input array. Findings without a verdict are tagged
 * "unverified" so the renderer can surface that. Pure.
 */
export function applyValidatorVerdicts(
	findings: readonly Finding[],
	verdicts: Map<number, ValidatorVerdict>,
): Finding[] {
	if (findings.length === 0) return [];
	return findings.map((finding, index) => {
		const v = verdicts.get(index);
		if (!v) {
			return { ...finding, _validatorVerdict: "unverified" };
		}
		return {
			...finding,
			_validatorVerdict: v.verdict,
			...(v.justification ? { _validatorJustification: v.justification } : {}),
		};
	});
}

/**
 * Run the validator stage over the synthesized findings. On any error
 * (model failure, unparseable output, etc.) the result is "fail open":
 * every finding is tagged "unverified" and surfaced unchanged, so a
 * flaky validator never silently drops a real finding.
 */
export async function runValidator(
	ctx: ExtensionContext,
	findings: readonly Finding[],
	diff: string,
	options?: { signal?: AbortSignal; lens?: string },
): Promise<ValidatorResult> {
	if (findings.length === 0) {
		return {
			findings: [],
			droppedFalsePositives: 0,
			confirmedReal: 0,
			unverified: 0,
		};
	}
	let systemPrompt: string;
	try {
		systemPrompt = await loadValidatorSystemPrompt();
	} catch (err) {
		// Missing prompt file shouldn't be possible in a built extension,
		// but if it is, fail open.
		console.warn("%s Validator prompt not found, skipping:", LOG_PREFIX, err);
		return {
			findings: findings.map((f) => ({
				...f,
				_validatorVerdict: "unverified",
			})),
			droppedFalsePositives: 0,
			confirmedReal: 0,
			unverified: findings.length,
			errorMessage: "validator prompt unavailable",
		};
	}

	const userPrompt = `${diff}\n\n${buildValidatorUserPrompt(findings)}`;

	let text: string;
	try {
		const result = await callLLM(
			ctx,
			systemPrompt,
			userPrompt,
			{
				temperature: 0,
				// Validator doesn't need a huge response — one short verdict
				// per finding, ~50 tokens each.
				maxTokens: Math.max(1000, findings.length * 80),
				signal: options?.signal,
			},
			options?.lens ?? "validator",
		);
		text = result.text;
	} catch (err) {
		// Fail open: surface findings unverified rather than dropping them.
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(
			"%s Validator call failed, marking unverified: %s",
			LOG_PREFIX,
			msg,
		);
		return {
			findings: findings.map((f) => ({
				...f,
				_validatorVerdict: "unverified",
			})),
			droppedFalsePositives: 0,
			confirmedReal: 0,
			unverified: findings.length,
			errorMessage: msg,
		};
	}

	const verdicts = parseValidatorOutput(text);
	if (verdicts.size === 0) {
		// No parseable output — fail open with unverified.
		console.warn(
			`${LOG_PREFIX} Validator returned no parseable verdicts; marking unverified.`,
		);
		return {
			findings: findings.map((f) => ({
				...f,
				_validatorVerdict: "unverified",
			})),
			droppedFalsePositives: 0,
			confirmedReal: 0,
			unverified: findings.length,
			errorMessage: "no parseable verdicts",
		};
	}

	const annotated = applyValidatorVerdicts(findings, verdicts);
	let droppedFalsePositives = 0;
	let confirmedReal = 0;
	let unverified = 0;
	for (const f of annotated) {
		if (f._validatorVerdict === "false-positive") droppedFalsePositives += 1;
		else if (f._validatorVerdict === "real") confirmedReal += 1;
		else unverified += 1;
	}
	return {
		findings: annotated,
		droppedFalsePositives,
		confirmedReal,
		unverified,
	};
}

/**
 * Load the validator system prompt from the bundled prompts dir.
 * The prompt is a project-shared fragment at
 * `src/prompts/_shared/validator.md` — see `prompt-architecture.md`.
 */
export async function loadValidatorSystemPrompt(): Promise<string> {
	const path = join(bundledPromptsDir(), "_shared", "validator.md");
	return readFile(path, "utf8");
}
