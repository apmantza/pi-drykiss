import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLLM } from "./llm.js";
import { loadPromptBody } from "./prompt-loader.js";
import { lenientJsonParse, isPlainObject } from "./json-utils.js";
import {
	getAllSourceFiles,
	getProjectIndex,
	type ProjectIndexEntry,
} from "./git-diff.js";
import { matchesAnyGlob } from "./glob-utils.js";
import type { ChangedFile } from "./types.js";
import { logAutoreviewEvent, logAutoreviewError } from "./logger.js";

export interface ScoutFile {
	readonly path: string;
	readonly reason: string;
	readonly priority: "high" | "medium" | "low";
}

export interface ScoutResult {
	readonly summary: string;
	readonly files: ScoutFile[];
	readonly excludedPatterns: readonly string[];
	readonly notDone: readonly string[];
}

export interface ScoutStatus {
	readonly phase: "started" | "success" | "fallback";
	readonly totalFiles?: number;
	readonly selectedFiles?: number;
	readonly modelName?: string;
	readonly reason?: string;
}

interface ScoutOptions {
	readonly cwd: string;
	/**
	 * Full file list. If omitted, the scout discovers files itself via
	 * `getAllSourceFiles`. Passing the list avoids a duplicate directory walk
	 * when the caller already has it.
	 */
	readonly allFiles?: readonly ChangedFile[];
	readonly maxFiles?: number;
	/** Correlates scout lifecycle events with the enclosing autoreview. */
	readonly correlationId?: string;
	readonly onStatus?: (status: ScoutStatus) => void;
	/**
	 * Glob patterns for docs the scout should read. Relative to the
	 * project root. Defaults to a standard set of project docs.
	 */
	readonly docs?: readonly string[];
	readonly ignorePatterns?: readonly string[];
	readonly signal?: AbortSignal;
}

const DEFAULT_DOC_GLOBS: readonly string[] = [
	"README.md",
	"AGENTS.md",
	"claude.md",
	"CONTRIBUTING.md",
	"package.json",
	"tsconfig.json",
	"llms.txt",
	"llms-full.txt",
];

const DEFAULT_MAX_FILES = 40;

/** Maximum characters of a single doc to include in the scout prompt. */
const DOC_BUDGET_PER_FILE = 4_000;

/** Maximum total doc characters to include in the scout prompt. */
const DOC_TOTAL_BUDGET = 10_000;

/** Maximum project-index entries to include in the scout prompt. */
const MAX_PROJECT_INDEX_ENTRIES = 50;

/**
 * Run the scout stage. On failure, returns `undefined` so the caller can
 * fall back to the full file list (fail-open).
 */
export async function runScout(
	ctx: ExtensionContext,
	options: ScoutOptions,
): Promise<ScoutResult | undefined> {
	const cwd = options.cwd;
	const correlation = options.correlationId
		? { correlationId: options.correlationId }
		: {};
	logAutoreviewEvent("scout.start", {
		...correlation,
		cwd,
		configuredMaxFiles: options.maxFiles,
		docPatterns: options.docs?.length ?? 0,
	});
	let modelName = "unknown";
	let totalFiles: number | undefined;

	try {
		const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
		const docGlobs = options.docs?.length ? options.docs : DEFAULT_DOC_GLOBS;
		const allFiles =
			options.allFiles ??
			(await getAllSourceFiles(cwd, options.ignorePatterns));
		totalFiles = allFiles.length;
		logAutoreviewEvent("scout.files_discovered", {
			...correlation,
			totalFiles,
		});
		options.onStatus?.({ phase: "started", totalFiles });

		if (allFiles.length === 0) {
			options.onStatus?.({
				phase: "fallback",
				totalFiles: 0,
				reason: "No source files found",
			});
			return undefined;
		}

		const [docs, projectIndex] = await Promise.all([
			loadScoutDocs(cwd, docGlobs),
			getProjectIndex(cwd, 200, undefined, options.ignorePatterns),
		]);
		logAutoreviewEvent("scout.context_ready", {
			...correlation,
			docs: docs.size,
			projectIndex: projectIndex.length,
		});
		const systemPrompt = await composeScoutPrompt();
		const userPrompt = buildScoutUserPrompt({
			cwd,
			docs,
			allFiles,
			projectIndex,
			maxFiles,
		});
		logAutoreviewEvent("scout.model_call_start", {
			...correlation,
			promptChars: userPrompt.length,
			maxFiles,
		});
		const response = await callLLM(
			ctx,
			systemPrompt,
			userPrompt,
			{
				signal: options.signal,
				maxTokens: 4000,
			},
			"scout",
		);
		modelName = response.model.name;
		logAutoreviewEvent("scout.model_call_complete", {
			...correlation,
			model: modelName,
			responseChars: response.text.length,
		});
		if (!response.text.trim()) {
			logAutoreviewEvent("scout.empty_response", {
				...correlation,
				model: modelName,
				totalFiles,
			});
			options.onStatus?.({
				phase: "fallback",
				totalFiles,
				modelName,
				reason: "Empty model response",
			});
			return undefined;
		}
		let result: ScoutResult | undefined;
		try {
			result = parseScoutResult(response.text, allFiles);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			logAutoreviewEvent("scout.parse_fallback", {
				...correlation,
				model: modelName,
				reason: reason.slice(0, 240),
			});
			options.onStatus?.({
				phase: "fallback",
				totalFiles,
				modelName,
				reason: `Invalid scout response: ${reason.slice(0, 200)}`,
			});
			return undefined;
		}
		if (!result) {
			logAutoreviewEvent("scout.parse_fallback", {
				...correlation,
				model: modelName,
				reason: "Invalid or empty scout response",
			});
			options.onStatus?.({
				phase: "fallback",
				totalFiles,
				modelName,
				reason: "Invalid or empty scout response",
			});
			return undefined;
		}
		logAutoreviewEvent("scout.success", {
			...correlation,
			model: modelName,
			selectedFiles: result.files.length,
			totalFiles,
		});
		options.onStatus?.({
			phase: "success",
			totalFiles,
			selectedFiles: result.files.length,
			modelName,
		});
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logAutoreviewError("scout.error", err, {
			...correlation,
			model: modelName,
			totalFiles,
		});
		options.onStatus?.({
			phase: "fallback",
			...(totalFiles !== undefined ? { totalFiles } : {}),
			modelName,
			reason: msg.slice(0, 240),
		});
		return undefined;
	}
}

async function composeScoutPrompt(): Promise<string> {
	const [ironLaw, scoutBody, jsonOutput, grounding] = await Promise.all([
		loadPromptBody("iron-law", "shared"),
		loadPromptBody("scout", "lens"),
		loadPromptBody("json-output-scout", "shared"),
		loadPromptBody("grounding-rules", "shared"),
	]);
	return [ironLaw, scoutBody, jsonOutput, grounding]
		.filter(Boolean)
		.join("\n\n");
}

interface ScoutPromptContext {
	readonly cwd: string;
	readonly docs: ReadonlyMap<string, string>;
	readonly allFiles: readonly ChangedFile[];
	readonly projectIndex: readonly ProjectIndexEntry[];
	readonly maxFiles: number;
}

function buildScoutUserPrompt(context: ScoutPromptContext): string {
	const parts: string[] = [];

	parts.push(
		"# Scout Request\n\nMap the project and select the most important files for a DRYKISS code review. Return ONLY the JSON object described in your system prompt.",
	);
	parts.push(
		`\n## Review Budget\n\nSelect up to ${context.maxFiles} files for review.`,
	);

	parts.push("\n## Project Documentation\n");
	if (context.docs.size === 0) {
		parts.push("(No docs found or readable.)");
	} else {
		for (const [name, content] of context.docs) {
			parts.push(`\n### ${name}\n\n${content}`);
		}
	}

	parts.push(`\n\n## Source Files (${context.allFiles.length} total)\n\n`);
	for (const file of context.allFiles) {
		parts.push(`- ${file.path}${file.language ? ` (${file.language})` : ""}`);
	}

	if (context.projectIndex.length > 0) {
		const limited = context.projectIndex.slice(0, MAX_PROJECT_INDEX_ENTRIES);
		parts.push(
			`\n\n## Project Index — Exported Symbols (${limited.length} of ${context.projectIndex.length} files)\n\n`,
		);
		for (const entry of limited) {
			const symbols = entry.exports.slice(0, 8).join(", ");
			const suffix = entry.exports.length > 8 ? " ..." : "";
			parts.push(`- ${entry.path}: ${symbols}${suffix}`);
		}
	}

	parts.push(
		"\n\n## Instructions\n\nReturn the JSON object now. Select files based on the priority rules in your system prompt. Do not include files you cannot justify.",
	);

	return parts.join("\n");
}

export async function loadScoutDocs(
	cwd: string,
	globs: readonly string[],
): Promise<Map<string, string>> {
	const docs = new Map<string, string>();
	let totalLength = 0;

	for (const glob of globs) {
		// We intentionally read literal files and simple glob-matched files.
		// For simplicity, treat the glob as a single file name if it has no
		// wildcards; otherwise expand it. For now, literal paths are enough
		// for README.md, AGENTS.md, etc.
		const candidates =
			glob.includes("*") || glob.includes("?")
				? await expandDocGlob(cwd, glob)
				: [glob];

		for (const candidate of candidates) {
			if (docs.has(candidate)) continue;
			try {
				const text = await readFile(join(cwd, candidate), "utf8");
				const truncated =
					text.length > DOC_BUDGET_PER_FILE
						? text.slice(0, DOC_BUDGET_PER_FILE) +
							"\n\n... (truncated for scout budget) ..."
						: text;
				if (totalLength + truncated.length > DOC_TOTAL_BUDGET) break;
				docs.set(candidate, truncated);
				totalLength += truncated.length;
			} catch {
				// Missing or unreadable docs are ignored; the scout can still work
				// from the file list and index.
			}
		}
	}

	return docs;
}

async function expandDocGlob(cwd: string, glob: string): Promise<string[]> {
	// For now, only support `*` in the filename, matching files in the cwd.
	if (!glob.includes("/")) {
		const { readdir } = await import("node:fs/promises");
		try {
			const entries = await readdir(cwd);
			return entries.filter((name) => matchesAnyGlob(name, [glob]));
		} catch {
			return [];
		}
	}
	return [];
}

function parseScoutResult(
	raw: string,
	allFiles: readonly ChangedFile[],
): ScoutResult | undefined {
	if (!raw.trim()) return undefined;
	const parsed = lenientJsonParse<unknown>(raw);
	if (!isPlainObject(parsed)) return undefined;

	const allowedPaths = new Set(allFiles.map((f) => f.path));
	const files = parseScoutFiles(parsed.files, allowedPaths);
	const excludedPatterns = parseStringArray(parsed.excludedPatterns);
	const notDone = parseStringArray(parsed.notDone);
	const summary = typeof parsed.summary === "string" ? parsed.summary : "";

	if (files.length === 0) return undefined;

	return { summary, files, excludedPatterns, notDone };
}

function parseScoutFiles(
	value: unknown,
	allowedPaths: ReadonlySet<string>,
): ScoutFile[] {
	if (!Array.isArray(value)) return [];
	const files: ScoutFile[] = [];
	const seen = new Set<string>();

	for (const item of value) {
		if (!isPlainObject(item)) continue;
		const path = String(item.path ?? "");
		if (!path || !allowedPaths.has(path)) continue;
		if (seen.has(path)) continue;
		seen.add(path);

		const priority = normalizePriority(item.priority);
		files.push({
			path,
			reason: typeof item.reason === "string" ? item.reason : "",
			priority,
		});
	}

	return files.sort(
		(a, b) => priorityRank(b.priority) - priorityRank(a.priority),
	);
}

function normalizePriority(value: unknown): ScoutFile["priority"] {
	if (value === "high" || value === "medium" || value === "low") return value;
	return "low";
}

function priorityRank(priority: ScoutFile["priority"]): number {
	return { high: 3, medium: 2, low: 1 }[priority];
}

function parseStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "string" ? item : ""))
		.filter((item) => item.length > 0);
}

/**
 * Apply a scout result to a list of discovered files, preserving the order
 * and metadata from the original files. Files not selected by the scout
 * are dropped. This is used by the review scope to narrow the full file list.
 */
export function applyScoutResult(
	allFiles: readonly ChangedFile[],
	scoutResult: ScoutResult,
): ChangedFile[] {
	const byPath = new Map(allFiles.map((f) => [f.path, f]));
	const selected: ChangedFile[] = [];
	for (const scoutFile of scoutResult.files) {
		const file = byPath.get(scoutFile.path);
		if (file) selected.push(file);
	}
	return selected;
}
