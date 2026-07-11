/**
 * prompt-builder.ts — Thin orchestrator for DRYKISS's prompt-loading and context-building.
 *
 * The actual prompt text lives in `.md` files under `src/prompts/` (see `prompt-architecture.md`).
 * This module:
 *   - Re-exports the loader/composer entry points (`loadLensSystemPrompt`, `loadSynthesisSystemPrompt`)
 *   - Builds the user-prompt context (file diffs, project index)
 *   - Re-exports the bundled-prompt seeder from `prompt-seed.ts`
 *   - Builds the auto-inject KISS/DRY checklist (this is TUI text, not an LLM prompt — exempt from the `.md` rule)
 *
 * Total: ~380 lines. Prompt seeding and file-system concerns live in `prompt-seed.ts`.
 */

import { join } from "node:path";
import type { ChangedFile, Finding, ReviewLens } from "./types.js";
import { LENS_NAMES } from "./types.js";
import type { ProjectIndexEntry } from "./git-diff.js";
import { userPromptsDir } from "./prompt-loader.js";
import {
	composeLensPrompt,
	composeSynthesisPrompt,
	type ComposeOptions,
} from "./prompt-composer.js";
import {
	modeToPosture,
	loadModeContextBlock,
} from "./mode-context.js";
import {
	loadProjectReviewPolicy,
	selectPathInstructions,
} from "./review-policy.js";
import type { ReviewPathInstruction } from "./config.js";

// Keep this indirection so vi.mock can intercept the loader in tests.
const _userPromptsDir = (): string => userPromptsDir();

export { ensureDefaultPrompts, resetPrompts } from "./prompt-seed.js";

/** Compose a lens system prompt. Delegates to the composer (P0.5). */
export async function loadLensSystemPrompt(
	lens: Exclude<ReviewLens, "all">,
	activeConstraints?: string,
): Promise<string> {
	return composeLensPrompt(lens, { activeConstraints });
}

/** Compose the synthesis system prompt. Delegates to the composer (P0.5). */
export async function loadSynthesisSystemPrompt(
	activeConstraints?: string,
): Promise<string> {
	return composeSynthesisPrompt({ activeConstraints });
}

/**
 * Variant that derives the active-constraints string from a RiskTargeting
 * config. Phase 2: lets the caller pass the config (e.g. from `loadEffectiveConfig`)
 * instead of a pre-formatted string.
 */
export async function loadLensSystemPromptWithConfig(
	lens: Exclude<ReviewLens, "all">,
	rt: import("./config.js").RiskTargeting | undefined,
): Promise<string> {
	const { buildActiveConstraints } = await import("./active-constraints.js");
	return composeLensPrompt(lens, {
		activeConstraints: buildActiveConstraints(rt),
	});
}

export async function loadSynthesisSystemPromptWithConfig(
	rt: import("./config.js").RiskTargeting | undefined,
): Promise<string> {
	const { buildActiveConstraints } = await import("./active-constraints.js");
	return composeSynthesisPrompt({
		activeConstraints: buildActiveConstraints(rt),
	});
}

/** Returns the path to a lens or synthesis prompt file in the user dir. */
export function getPromptPath(lens: ReviewLens | "synthesis"): string {
	return join(_userPromptsDir(), `${lens}.md`);
}

// ── Context building ────────────────────────────────────────────────────

export interface FileContext {
	readonly diff: string;
	readonly content?: string;
	readonly lineCount?: number;
	readonly truncated?: boolean;
}

function buildFileContext(
	files: ChangedFile[],
	diffs: Map<string, string>,
	contents?: Map<
		string,
		{ content: string; lineCount: number; truncated: boolean }
	>,
): string {
	const sections: string[] = [];
	for (const file of files) {
		const diff = diffs.get(file.path) ?? "";
		const full = contents?.get(file.path);
		const parts: string[] = [];

		parts.push(
			`--- ${file.path} (${file.status}${file.language ? ", " + file.language : ""}) ---`,
		);

		if (full) {
			parts.push(
				`\n### Full file (${full.lineCount} lines${full.truncated ? ", truncated to 500" : ""})\n${full.content}`,
			);
		}

		parts.push(`\n### Diff\n${diff || "(diff not available)"}`);
		sections.push(parts.join("\n"));
	}
	return sections.join("\n\n");
}

function buildProjectIndexContext(index: ProjectIndexEntry[]): string {
	if (index.length === 0) return "";
	const lines: string[] = [
		"\n### Project Index — Existing modules and exports\n",
	];
	for (const entry of index) {
		lines.push(
			`- ${entry.path}: ${entry.exports.slice(0, 12).join(", ")}${entry.exports.length > 12 ? " ..." : ""}`,
		);
	}
	return lines.join("\n");
}

function buildCommandsContext(
	commands: { test?: string; lint?: string } | undefined,
): string {
	if (!commands || (!commands.test && !commands.lint)) return "";
	const lines = ["\n### Configured Commands\n"];
	if (commands.test) lines.push(`- Test command: \`${commands.test}\``);
	if (commands.lint) lines.push(`- Lint command: \`${commands.lint}\``);
	lines.push(
		"Use these commands when validating findings, but only run safe read-only checks.",
	);
	return lines.join("\n");
}

const EXAMINE_CONTEXT_INSTRUCTION =
	"Read the following context files COMPLETELY. For each finding, QUOTE specific line numbers and code. Do NOT report issues you cannot verify with exact code evidence. Output findings as JSON only.";

// ── Public API ──────────────────────────────────────────────────────────

export interface ReviewPrompt {
	readonly lens: ReviewLens;
	readonly systemPrompt: string;
	readonly userPrompt: string;
}

/**
 * Load project-specific review guidelines if present.
 * Looks for `.pi/drykiss/review-guidelines.md` (preferred) or
 * `REVIEW_GUIDELINES.md` next to `.pi` and returns the trimmed contents,
 * or `null` if no file exists.
 */
export async function loadProjectReviewGuidelines(
	cwd: string,
): Promise<string | null> {
	return (await loadProjectReviewPolicy(cwd)).markdown;
}

export async function buildReviewPrompts(
	cwd: string,
	files: ChangedFile[],
	diffs: Map<string, string>,
	lens: ReviewLens,
	options?: {
		contents?: Map<
			string,
			{ content: string; lineCount: number; truncated: boolean }
		>;
		projectIndex?: ProjectIndexEntry[];
		activeConstraints?: string;
		commands?: { test?: string; lint?: string };
		guidelines?: string | null;
		pathInstructions?: readonly ReviewPathInstruction[];
		/**
		 * Review mode (e.g. "pr", "commit", "full"). When provided, a
		 * posture-specific context block is injected into the user prompt
		 * so lenses frame the review correctly (proposed-change gate vs
		 * codebase audit). See `./mode-context.ts`.
		 */
		mode?: string;
		/** Human-readable scope label (e.g. "owner/repo#123", "full codebase"). */
		scopeLabel?: string;
	},
): Promise<ReviewPrompt[]> {
	const context = buildFileContext(files, diffs, options?.contents);
	const indexBlock = options?.projectIndex
		? buildProjectIndexContext(options.projectIndex)
		: "";
	const commandsBlock = buildCommandsContext(options?.commands);
	const composeOpts: ComposeOptions = {
		activeConstraints: options?.activeConstraints,
	};
	const guidelines =
		options?.guidelines === undefined
			? await loadProjectReviewGuidelines(cwd)
			: options.guidelines;
	// Load the posture context block once (mode-agnostic across lenses).
	// Fail-open: missing mode or missing fragment → no block, preserving
	// the pre-mode-awareness behavior for callers that don't pass mode.
	const modeContext = options?.mode
		? await loadModeContextBlock(
				modeToPosture(options.mode),
				options.scopeLabel,
			)
		: "";

	function buildUserPrompt(
		currentLens: Exclude<ReviewLens, "all">,
		includeIndex: boolean,
	): string {
		let prompt = EXAMINE_CONTEXT_INSTRUCTION;
		if (modeContext) prompt += `\n\n${modeContext}`;
		prompt += `\n\n${context}`;
		if (commandsBlock) prompt += `\n${commandsBlock}`;
		if (includeIndex && indexBlock) prompt += `\n${indexBlock}`;
		const pathInstructions = selectPathInstructions(
			files,
			currentLens,
			options?.pathInstructions,
		);
		if (guidelines) {
			prompt += `\n\n## Project Review Guidelines\n\n${guidelines}`;
		}
		if (pathInstructions.length > 0) {
			prompt += `\n\n${pathInstructions.join("\n\n")}`;
		}
		return prompt;
	}

	if (lens !== "all") {
		const systemPrompt = await composeLensPrompt(lens, composeOpts);
		const userPrompt = buildUserPrompt(lens, lens === "deduplication");
		return [{ lens, systemPrompt, userPrompt }];
	}

	const prompts: ReviewPrompt[] = [];
	for (const l of LENS_NAMES) {
		const systemPrompt = await composeLensPrompt(l, composeOpts);
		const userPrompt = buildUserPrompt(l, l === "deduplication");
		prompts.push({ lens: l, systemPrompt, userPrompt });
	}
	return prompts;
}

export async function buildSynthesisPrompt(
	_cwd: string,
	lensReviews: Array<{ lens: string; rawOutput: string }>,
	options?: { activeConstraints?: string },
): Promise<{ systemPrompt: string; userPrompt: string }> {
	const systemPrompt = await composeSynthesisPrompt({
		activeConstraints: options?.activeConstraints,
	});

	let userPrompt = "# Independent Reviewer Findings\n\n";
	for (const review of lensReviews) {
		if (review.rawOutput.startsWith("ERROR:")) {
			userPrompt += `## ${review.lens.toUpperCase()} REVIEWER\n\n[This reviewer encountered an error and produced no findings.]\n\n---\n\n`;
		} else {
			userPrompt += `## ${review.lens.toUpperCase()} REVIEWER\n\n${review.rawOutput}\n\n---\n\n`;
		}
	}
	userPrompt +=
		'\nSynthesize these findings into the final JSON report. If there are no findings, output {"summary": "No issues found", "verdict": "Approve", "findings": []}. Output ONLY valid JSON — no markdown fences, no commentary.';

	return { systemPrompt, userPrompt };
}

/**
 * Bucketing-aware synthesis prompt: cluster findings from all lenses into
 * candidate groups (file + line proximity + Jaccard), then present them
 * to the synthesis LLM as a numbered list of buckets with vote counts
 * and contributing lens names. The LLM still does the final semantic
 * merge — it can override the cluster boundaries — but starts from a
 * pre-deduplicated view that is dramatically smaller than the raw
 * N-lens output.
 *
 * Compared to `buildSynthesisPrompt` (which feeds raw JSON arrays to
 * the synthesizer), this version:
 *   - Cuts prompt size by collapsing obvious duplicates up front.
 *   - Surfaces vote count + contributing lenses as a confidence signal.
 *   - Preserves the LLM's authority: cluster boundaries are
 *     advisory, not authoritative. The LLM can merge across buckets
 *     when it sees a real semantic match.
 *
 * Fail-open: if a lens's raw output can't be parsed, its findings are
 * dropped from the bucketing step but the lens is still mentioned in
 * the prompt so the synthesizer knows that lens ran.
 */
export async function buildBucketedSynthesisPrompt(
	lensReviews: Array<{ lens: string; rawOutput: string }>,
	options?: { activeConstraints?: string },
): Promise<{ systemPrompt: string; userPrompt: string }> {
	const { clusterAndFlatten } = await import("./bucketing.js");
	const { parseFindingsJson } = await import("./parse-findings.js");
	const { formatBucketsForPrompt } = await import("./bucketing.js");
	const { LENS_DISPLAY_NAMES } = await import("./constants.js");
	const systemPrompt = await composeSynthesisPrompt({
		activeConstraints: options?.activeConstraints,
	});

	// Parse each lens's raw output and accumulate its findings, tagging
	// the source lens so the bucketer can count distinct contributors.
	const allFindings: Finding[] = [];
	const lensStatuses: Array<{ lens: string; ok: boolean; error?: string }> = [];
	for (const review of lensReviews) {
		if (review.rawOutput.startsWith("ERROR:")) {
			lensStatuses.push({
				lens: review.lens,
				ok: false,
				error: review.rawOutput,
			});
			continue;
		}
		const { findings, parseError } = parseFindingsJson(
			review.rawOutput,
			review.lens as ReviewLens,
		);
		if (parseError) {
			lensStatuses.push({ lens: review.lens, ok: false, error: parseError });
			continue;
		}
		lensStatuses.push({ lens: review.lens, ok: true });
		allFindings.push(...findings);
	}

	const buckets = clusterAndFlatten(allFindings);

	let userPrompt = "# Clustered Reviewer Findings\n\n";
	userPrompt +=
		"Below are findings from all lenses, clustered by file + line proximity + textual similarity. ";
	userPrompt +=
		"Each bucket is a candidate 'same defect' group with a vote count and the list of contributing lenses. ";
	userPrompt +=
		"You may merge across buckets when you see a real semantic match; cluster boundaries are advisory.\n\n";

	// Lens status line so the synthesizer knows which lenses ran.
	userPrompt += "## Lens Status\n\n";
	for (const status of lensStatuses) {
		const name = LENS_DISPLAY_NAMES[status.lens] ?? status.lens;
		if (status.ok) {
			userPrompt += `- ${name}: ok\n`;
		} else {
			userPrompt += `- ${name}: error (${status.error ?? "unknown"})\n`;
		}
	}
	userPrompt += "\n";

	if (buckets.length === 0) {
		userPrompt += "## Buckets\n\n(no findings)\n\n";
	} else {
		userPrompt += `## Buckets (${buckets.length})\n\n${formatBucketsForPrompt(buckets)}\n\n`;
	}

	userPrompt +=
		'\nSynthesize these clusters into the final JSON report. Each bucket represents a candidate finding; assign the final severity, category, summary, and suggestion yourself. If a cluster spans two distinct issues, you may split it. If there are no findings, output {"summary": "No issues found", "verdict": "Approve", "findings": []}. Output ONLY valid JSON — no markdown fences, no commentary.';

	return { systemPrompt, userPrompt };
}

/**
 * Builds the KISS/DRY quick-check block for the auto-injector.
 * MOVED to src/auto-inject.ts. This export is a thin re-export for backward compat.
 */
export { buildAutoInjectBlock } from "./auto-inject.js";
