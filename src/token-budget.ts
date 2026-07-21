/**
 * token-budget.ts — Lightweight token estimation and context-window budget enforcement.
 *
 * Uses a char/4 approximation to avoid a tiktoken dependency.
 * Budget enforcement is applied in prompt-builder.ts before the user prompt is assembled.
 */

import type { ChangedFile } from "./types.js";
import { LOG_PREFIX } from "./constants.js";

/** Estimate token count for a string using the char/4 heuristic. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export interface FileEntry {
	readonly file: ChangedFile;
	readonly diff: string;
	readonly content?: { content: string; lineCount: number; truncated: boolean };
}

/**
 * Apply token budget enforcement to a set of files.
 *
 * If `maxContextTokens` is undefined, returns the files unchanged.
 *
 * When a budget is set:
 *   1. Estimate tokens for overhead (system prompt + fixed prompt parts).
 *   2. Sort files by priority: files with non-empty diffs first, then by
 *      ascending content size (smaller files are cheaper and kept first).
 *   3. Drop the lowest-priority files until the total estimated token count
 *      fits within the budget.
 *   4. Log a warning if any files were dropped.
 *
 * Returns the surviving file list in the original input order.
 */
export function applyTokenBudget(
	entries: FileEntry[],
	overhead: string,
	maxContextTokens: number | undefined,
): FileEntry[] {
	if (maxContextTokens === undefined || entries.length === 0) {
		return entries;
	}

	const overheadTokens = estimateTokens(overhead);
	const availableTokens = maxContextTokens - overheadTokens;

	// Estimate tokens per file (diff + full content if present).
	function fileTokens(entry: FileEntry): number {
		const diffTokens = estimateTokens(entry.diff);
		const contentTokens = entry.content
			? estimateTokens(entry.content.content)
			: 0;
		// Add a small header overhead (~20 tokens) per file for the section header.
		return diffTokens + contentTokens + 20;
	}

	// Sort by priority: files with diffs come first (keep them), then ascending size.
	// We work on a copy so the original order can be recovered after filtering.
	const prioritized = entries
		.map((entry, originalIndex) => ({
			entry,
			originalIndex,
			tokens: fileTokens(entry),
			hasDiff:
				entry.diff.length > 0 &&
				entry.diff !== "(diff not available)" &&
				entry.diff !== "(diff unavailable)",
		}))
		.sort((a, b) => {
			// Files with diffs have higher priority (sort first = keep first).
			if (a.hasDiff !== b.hasDiff) return a.hasDiff ? -1 : 1;
			// Among files of equal diff status, prefer smaller files (ascending tokens).
			return a.tokens - b.tokens;
		});

	let usedTokens = 0;
	const keptIndices = new Set<number>();

	for (const item of prioritized) {
		if (usedTokens + item.tokens <= availableTokens) {
			usedTokens += item.tokens;
			keptIndices.add(item.originalIndex);
		}
		// Once we cannot fit a file, continue iterating — a smaller file later
		// might still fit.
	}

	const droppedCount = entries.length - keptIndices.size;
	if (droppedCount > 0) {
		console.warn(
			`${LOG_PREFIX} Token budget exceeded: dropped ${droppedCount} file${droppedCount === 1 ? "" : "s"} to fit within ${maxContextTokens} tokens`,
		);
	}

	// Return surviving entries in their original input order.
	return entries.filter((_, i) => keptIndices.has(i));
}
