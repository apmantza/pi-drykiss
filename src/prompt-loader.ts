/**
 * prompt-loader.ts — Reads prompt .md files from disk.
 *
 * All prompt text in DRYKISS lives in `.md` files (see `prompt-architecture.md`).
 * This module is the only place in the codebase that knows about the file layout.
 *
 * Resolution order for `PromptSource.dir`:
 *   1. `process.env.DRYKISS_PROMPTS_DIR` (debug override)
 *   2. `~/.pi/drykiss/prompts/` (user-customized prompts)
 *   3. Bundled defaults at `src/prompts/` (resolved via `new URL(...)` and `import.meta.url`)
 *
 * Functions in this module are pure file-IO — no string concatenation, no substitutions.
 * Composition is the job of `prompt-composer.ts`.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { getGlobalBaseDir } from "./constants.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { logAutoreviewEvent, logAutoreviewError } from "./logger.js";
import { BUILT_IN_LENS_SET } from "./types.js";

export interface PromptSource {
	/** Where to read prompts from. */
	readonly dir: string;
}

function requirePromptContent(
	raw: string | null | undefined,
	path: string,
	kind: string,
): string {
	if (raw === null || raw === undefined) {
		throw Object.assign(new Error(`${kind} returned null: ${path}`), {
			code: "ENOENT" as const,
		});
	}
	return raw;
}

/** Returns the bundled `src/prompts/` directory as an absolute path. */
export function bundledPromptsDir(): string {
	// jiti + tsx resolve `import.meta.url` to the source file's URL.
	// The bundled prompts live at `<repo>/src/prompts/`, i.e. one level up from `src/prompt-loader.ts`.
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "prompts");
}

/** Returns the user's customized prompts dir (`~/.pi/drykiss/prompts/`). */
export function userPromptsDir(): string {
	return join(getGlobalBaseDir(), "prompts");
}

/**
 * Resolve a `PromptSource.dir` according to the resolution order.
 * Env var > user dir > bundled. The bundled dir is always the last-resort fallback.
 */
export function resolvePromptsDir(): string {
	const env = process.env.DRYKISS_PROMPTS_DIR;
	if (env && env.trim().length > 0) {
		return isAbsolute(env) ? env : join(process.cwd(), env);
	}
	return userPromptsDir();
}

/** The default `PromptSource` — resolves to the user dir (with env override). */
export function defaultPromptSource(): PromptSource {
	return { dir: resolvePromptsDir() };
}

/**
 * Load a per-lens prompt `.md` file from a `PromptSource`.
 * Caller is responsible for trying `userPromptsDir()` first and `bundledPromptsDir()` as a fallback.
 */
export async function loadPromptFile(
	source: PromptSource,
	name: string,
): Promise<string> {
	const path = join(source.dir, `${name}.md`);
	const raw = await readFile(path, "utf8");
	// Treat null/undefined as missing (test mocks may return these)
	return requirePromptContent(raw, path, "prompt file");
}

/**
 * Load a shared fragment from `<source.dir>/_shared/<name>.md`.
 */
export async function loadSharedFragment(
	source: PromptSource,
	name: string,
): Promise<string> {
	const path = join(source.dir, "_shared", `${name}.md`);
	const raw = await readFile(path, "utf8");
	return requirePromptContent(raw, path, "shared fragment");
}

/**
 * Load a prompt body, trying the user dir first and falling back to the bundled dir on ENOENT.
 * Results are cached in memory for the lifetime of the process to avoid repeated disk reads.
 * This is the function every other module should call.
 */
const promptCache = new Map<string, string>();

function cacheKey(name: string, kind: "lens" | "shared"): string {
	const env = process.env.DRYKISS_PROMPTS_DIR;
	return env ? `env:${env}:${kind}:${name}` : `${kind}:${name}`;
}

export function clearPromptCache(): void {
	promptCache.clear();
}

export async function loadPromptBody(
	name: string,
	kind: "lens" | "shared" = "lens",
): Promise<string> {
	const key = cacheKey(name, kind);
	const cached = promptCache.get(key);
	if (cached !== undefined) {
		logAutoreviewEvent("prompt.cache_hit", { name, kind });
		return cached;
	}

	const env = process.env.DRYKISS_PROMPTS_DIR;
	const dirs =
		env && env.trim().length > 0
			? [env, bundledPromptsDir()]
			: [userPromptsDir(), bundledPromptsDir()];

	let lastErr: unknown;
	for (const dir of dirs) {
		try {
			const result = await (kind === "lens"
				? loadPromptFile({ dir }, name)
				: loadSharedFragment({ dir }, name));
			promptCache.set(key, result);
			logAutoreviewEvent("prompt.loaded", {
				name,
				kind,
				source: dir,
				chars: result.length,
			});
			return result;
		} catch (err) {
			if (
				err instanceof Error &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				lastErr = err;
				logAutoreviewEvent("prompt.missing", { name, kind, source: dir });
				continue;
			}
			logAutoreviewError("prompt.load_error", err, {
				name,
				kind,
				source: dir,
			});
			throw err;
		}
	}

	throw lastErr;
}

/**
 * Scan the user's prompts directory (`~/.pi/drykiss/prompts/`) for `.md`
 * files that do not match any built-in lens name (or the special shared
 * fragments inside `_shared/`). Returns the discovered lens names (without
 * the `.md` extension) sorted alphabetically.
 *
 * This function is fail-open: if the directory does not exist or cannot be
 * read, it returns an empty array rather than throwing.
 */
export async function discoverCustomLenses(): Promise<string[]> {
	const env = process.env.DRYKISS_PROMPTS_DIR;
	const dir =
		env && env.trim().length > 0
			? isAbsolute(env)
				? env
				: join(process.cwd(), env)
			: userPromptsDir();

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		// Directory does not exist or is unreadable — no custom lenses.
		return [];
	}

	const custom: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const name = entry.slice(0, -3); // strip ".md"
		// Skip built-in lenses and shared fragments (prefixed with "_").
		if (BUILT_IN_LENS_SET.has(name)) continue;
		if (name.startsWith("_")) continue;
		// Skip meta names used by built-in shared fragments and synthesis.
		const reserved = new Set([
			"synthesis",
			"iron-law",
			"json-output",
			"json-output-synthesis",
			"grounding-rules",
			"grounding-rules-synthesis",
			"active-constraints",
		]);
		if (reserved.has(name)) continue;
		custom.push(name);
	}

	custom.sort();
	if (custom.length > 0) {
		logAutoreviewEvent("prompt.custom_lenses_discovered", {
			dir,
			lenses: custom,
		});
	}
	return custom;
}
