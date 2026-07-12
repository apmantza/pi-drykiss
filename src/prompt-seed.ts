/** Prompt seed management for DRYKISS's user-customized Markdown prompts. */

import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { bundledPromptsDir, userPromptsDir } from "./prompt-loader.js";
import { getNodeErrorCode, LOG_PREFIX } from "./constants.js";

// Helper functions go through the module namespace so tests can mock the
// loader across the Vitest + jiti boundary.
const _userPromptsDir = (): string => userPromptsDir();
const _bundledPromptsDir = (): string => bundledPromptsDir();

const BUNDLED_LENS_FILES = [
	"simplicity.md",
	"deduplication.md",
	"clarity.md",
	"resilience.md",
	"architecture.md",
	"tests.md",
	"security.md",
	"docs.md",
	"synthesis.md",
	"scout.md",
] as const;

const BUNDLED_SHARED_FILES = [
	"iron-law.md",
	"json-output.md",
	"json-output-synthesis.md",
	"json-output-scout.md",
	"grounding-rules.md",
	"grounding-rules-synthesis.md",
	"validator.md",
	"active-constraints.md",
	"mode-context-proposed.md",
	"mode-context-audit.md",
] as const;

const SENTINEL_PREFIX = ".drykiss-prompt-v";
const CURRENT_SEED_VERSION = "7";

function sentinelPath(dir: string): string {
	return join(dir, `${SENTINEL_PREFIX}${CURRENT_SEED_VERSION}`);
}

async function isSeeded(dir: string): Promise<boolean> {
	try {
		await readFile(sentinelPath(dir), "utf8");
		return true;
	} catch (err) {
		if (getNodeErrorCode(err) === "ENOENT") return false;
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
			entries.flatMap((name) => {
				if (
					!name.startsWith(SENTINEL_PREFIX) ||
					name === `${SENTINEL_PREFIX}${CURRENT_SEED_VERSION}`
				) {
					return [];
				}
				return [
					writeFile(join(dir, name), "", "utf8")
						.then(() => undefined)
						.catch((err) => {
							console.warn(
								`${LOG_PREFIX} Failed to clear old sentinel ${name}: ${err instanceof Error ? err.message : String(err)}`,
							);
							return undefined;
						}),
				];
			}),
		);
	} catch (err) {
		if (getNodeErrorCode(err) !== "ENOENT") {
			console.warn(
				`${LOG_PREFIX} Failed to list old sentinels: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

async function copyBundledFile(src: string, dest: string): Promise<void> {
	const content = await readFile(src, "utf8");
	await writeFile(dest, content, "utf8");
}

async function copyBundledPrompts(
	bundledDir: string,
	userDir: string,
): Promise<void> {
	await mkdir(userDir, { recursive: true });
	await mkdir(join(userDir, "_shared"), { recursive: true });

	await Promise.all(
		BUNDLED_LENS_FILES.map(async (filename) => {
			try {
				await copyBundledFile(
					join(bundledDir, filename),
					join(userDir, filename),
				);
			} catch (err) {
				throw new Error(
					`Failed to seed prompt ${filename}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return undefined;
		}),
	);

	await Promise.all(
		BUNDLED_SHARED_FILES.map(async (filename) => {
			try {
				await copyBundledFile(
					join(bundledDir, "_shared", filename),
					join(userDir, "_shared", filename),
				);
			} catch (err) {
				throw new Error(
					`Failed to seed shared fragment ${filename}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return undefined;
		}),
	);
}

/** Seed bundled prompts into the user directory on first use. */
export async function ensureDefaultPrompts(_cwd: string): Promise<void> {
	const userDir = _userPromptsDir();
	await mkdir(userDir, { recursive: true });
	if (await isSeeded(userDir)) return;

	await copyBundledPrompts(_bundledPromptsDir(), userDir);
	await removeOldSentinels(userDir);
	await writeSentinel(userDir);
}

/** Force re-seeding of all bundled prompts. */
export async function resetPrompts(): Promise<void> {
	const userDir = _userPromptsDir();
	await copyBundledPrompts(_bundledPromptsDir(), userDir);
	await writeSentinel(userDir);
}
