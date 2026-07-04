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

import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { getGlobalBaseDir } from "./constants.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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
 * This is the function every other module should call.
 */
export async function loadPromptBody(
	name: string,
	kind: "lens" | "shared" = "lens",
): Promise<string> {
	const userDir = userPromptsDir();
	const bundledDir = bundledPromptsDir();
	const env = process.env.DRYKISS_PROMPTS_DIR;

	// Env var short-circuits the resolution order
	if (env && env.trim().length > 0) {
		return kind === "lens"
			? loadPromptFile({ dir: env }, name)
			: loadSharedFragment({ dir: env }, name);
	}

	try {
		return await (kind === "lens"
			? loadPromptFile({ dir: userDir }, name)
			: loadSharedFragment({ dir: userDir }, name));
	} catch (err) {
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			// Fall back to bundled defaults
			return kind === "lens"
				? loadPromptFile({ dir: bundledDir }, name)
				: loadSharedFragment({ dir: bundledDir }, name);
		}
		throw err;
	}
}
