/**
 * prompt-builder.ts — Thin orchestrator for DRYKISS's prompt-loading and context-building.
 *
 * The actual prompt text lives in `.md` files under `src/prompts/` (see `prompt-architecture.md`).
 * This module:
 *   - Re-exports the loader/composer entry points (`loadLensSystemPrompt`, `loadSynthesisSystemPrompt`)
 *   - Builds the user-prompt context (file diffs, project index)
 *   - Provides the bundled-prompt seeder (`ensureDefaultPrompts`, `resetPrompts`)
 *   - Builds the auto-inject KISS/DRY checklist (this is TUI text, not an LLM prompt — exempt from the `.md` rule)
 *
 * Total: ~230 lines. The previous version was 790 lines because it embedded ~600 lines of prompt text.
 */

import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChangedFile, ReviewLens } from "./types.js";
import { LENS_NAMES } from "./types.js";
import type { ProjectIndexEntry } from "./git-diff.js";
import { bundledPromptsDir, userPromptsDir } from "./prompt-loader.js";
import {
	composeLensPrompt,
	composeSynthesisPrompt,
	type ComposeOptions,
} from "./prompt-composer.js";

// Helper functions that go through the module namespace so vi.mock can
// intercept the calls. (Destructured imports are not always live-bound
// across the vitest + jiti boundary, so we wrap with thin delegators.)
const _userPromptsDir = (): string => userPromptsDir();
const _bundledPromptsDir = (): string => bundledPromptsDir();

// ── Re-exports for backward compat ──────────────────────────────────────

/** @deprecated Use bundledPromptsDir from ./prompt-loader.js. Kept for tests. */
export { bundledPromptsDir, userPromptsDir } from "./prompt-loader.js";

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

// ── Bundled-defaults manifest ──────────────────────────────────────────

/** All per-lens prompt filenames shipped in the bundle. */
const BUNDLED_LENS_FILES = [
	"simplicity.md",
	"deduplication.md",
	"clarity.md",
	"resilience.md",
	"architecture.md",
	"tests.md",
	"security.md",
	"synthesis.md",
] as const;

/** All shared-fragment filenames shipped in the bundle. */
const BUNDLED_SHARED_FILES = [
	"iron-law.md",
	"json-output.md",
	"json-output-synthesis.md",
	"grounding-rules.md",
	"grounding-rules-synthesis.md",
	"kiss-dry-checklist.md",
	"active-constraints.md",
] as const;

/** Sentinel filename. Present = seeded at version X.Y.Z. */
const SENTINEL_PREFIX = ".drykiss-prompt-v";
const CURRENT_SEED_VERSION = "1"; // bump to force re-seed

function sentinelPath(dir: string): string {
	return join(dir, `${SENTINEL_PREFIX}${CURRENT_SEED_VERSION}`);
}

async function isSeeded(dir: string): Promise<boolean> {
	try {
		await readFile(sentinelPath(dir), "utf8");
		return true;
	} catch (err) {
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return false;
		}
		throw err;
	}
}

async function writeSentinel(dir: string): Promise<void> {
	await writeFile(
		sentinelPath(dir),
		`DRYKISS prompt seed v${CURRENT_SEED_VERSION}\n`,
		"utf8",
	);
}

async function removeOldSentinels(dir: string): Promise<void> {
	try {
		const entries = await readdir(dir);
		await Promise.all(
			entries
				.filter(
					(name) =>
						name.startsWith(SENTINEL_PREFIX) &&
						name !== `${SENTINEL_PREFIX}${CURRENT_SEED_VERSION}`,
				)
				.map((name) =>
					writeFile(join(dir, name), "", "utf8")
						.then(() => undefined)
						.catch(() => undefined),
				),
		);
	} catch {
		// dir doesn't exist yet — nothing to clean
	}
}

async function copyBundledFile(src: string, dest: string): Promise<void> {
	const content = await readFile(src, "utf8");
	await writeFile(dest, content, "utf8");
}

/**
 * Seed the user's prompt dir with all bundled `.md` files on first run.
 * Sentinel-gated: subsequent calls are no-ops.
 */
export async function ensureDefaultPrompts(_cwd: string): Promise<void> {
	try {
		const userDir = _userPromptsDir();
		await mkdir(userDir, { recursive: true });

		if (await isSeeded(userDir)) {
			return; // already seeded at this version
		}

		const bundledDir = _bundledPromptsDir();

		// Copy per-lens prompts
		await Promise.all(
			BUNDLED_LENS_FILES.map(async (filename) => {
				const src = join(bundledDir, filename);
				const dest = join(userDir, filename);
				try {
					await copyBundledFile(src, dest);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
				}
			}),
		);

		// Copy shared fragments
		await Promise.all(
			BUNDLED_SHARED_FILES.map(async (filename) => {
				const src = join(bundledDir, "_shared", filename);
				const dest = join(userDir, "_shared", filename);
				await mkdir(join(userDir, "_shared"), { recursive: true });
				try {
					await copyBundledFile(src, dest);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
				}
			}),
		);

		// Clean up old-version sentinels and write the new one
		await removeOldSentinels(userDir);
		await writeSentinel(userDir);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw err;
	}
}

/**
 * Force re-seed: overwrite every bundled file in the user dir and refresh the sentinel.
 */
export async function resetPrompts(): Promise<void> {
	const userDir = _userPromptsDir();
	await mkdir(userDir, { recursive: true });

	const bundledDir = _bundledPromptsDir();

	for (const filename of BUNDLED_LENS_FILES) {
		const src = join(bundledDir, filename);
		const dest = join(userDir, filename);
		await copyBundledFile(src, dest);
	}

	await mkdir(join(userDir, "_shared"), { recursive: true });
	for (const filename of BUNDLED_SHARED_FILES) {
		const src = join(bundledDir, "_shared", filename);
		const dest = join(userDir, "_shared", filename);
		await copyBundledFile(src, dest);
	}

	await writeSentinel(userDir);
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

// ── Public API ──────────────────────────────────────────────────────────

export interface ReviewPrompt {
	readonly lens: ReviewLens;
	readonly systemPrompt: string;
	readonly userPrompt: string;
}

export async function buildReviewPrompts(
	_cwd: string,
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
	},
): Promise<ReviewPrompt[]> {
	const context = buildFileContext(files, diffs, options?.contents);
	const indexBlock = options?.projectIndex
		? buildProjectIndexContext(options.projectIndex)
		: "";
	const composeOpts: ComposeOptions = {
		activeConstraints: options?.activeConstraints,
	};

	if (lens !== "all") {
		const systemPrompt = await composeLensPrompt(lens, composeOpts);
		const userPrompt =
			lens === "deduplication" && indexBlock
				? `Review the following code changes for ${lens} issues. Output findings as JSON only.\n\n${context}\n${indexBlock}`
				: `Review the following code changes for ${lens} issues. Output findings as JSON only.\n\n${context}`;
		return [{ lens, systemPrompt, userPrompt }];
	}

	const prompts: ReviewPrompt[] = [];
	for (const l of LENS_NAMES) {
		const systemPrompt = await composeLensPrompt(l, composeOpts);
		const userPrompt =
			l === "deduplication" && indexBlock
				? `Review the following code changes. Output findings as JSON only.\n\n${context}\n${indexBlock}`
				: `Review the following code changes. Output findings as JSON only.\n\n${context}`;
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
 * Builds the KISS/DRY quick-check block for the auto-injector.
 * This is a TUI-side message (printed into the conversation after an edit),
 * NOT an LLM system prompt. Exempt from the `.md`-only constraint.
 */
export function buildAutoInjectBlock(edits: {
	files: ReadonlyArray<{ path: string; language: string | null }>;
}): string {
	const fileList = edits.files.map((f) => f.path).join(", ");
	return `\n\n## KISS/DRY Quick Check

You edited: ${fileList}. Before proceeding, briefly verify:

- [ ] **KISS**: Is the new code as simple as the problem allows? No unnecessary layers or clever one-liners? No speculative features?
- [ ] **DRY**: Is knowledge represented once? No copy-pasted logic or scattered conditionals?
- [ ] **Names**: Do variables/functions reveal intent, not mechanism? (No 'temp', 'data', 'result' without context)
- [ ] **Size**: Are functions focused on one thing? Any function worth splitting?
- [ ] **Comments**: Do they explain WHY, not WHAT?
- [ ] **Edge cases**: Are null, empty, and boundary values handled?
- [ ] **Security**: Is user input validated at boundaries? No raw SQL concatenation?
- [ ] **Resilience**: Are errors handled specifically, not swallowed? Are async failures caught?
- [ ] **Architecture**: Does the change follow existing patterns? Is the interface small and the behavior rich (deep module)?

Fix any quick wins, then continue.`;
}
