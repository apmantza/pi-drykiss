/**
 * Shared constants for the DRYKISS extension.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** Base directory for all DRYKISS config and data */
export const DRYKISS_BASE_DIR = ".pi/drykiss";

/** Global base directory (under home) */
export function getGlobalBaseDir(): string {
	return join(homedir(), DRYKISS_BASE_DIR);
}

/**
 * Project-local base directory. When `cwd` is provided and the project
 * has a `.pi/drykiss` directory, returns the path to it. Otherwise
 * returns undefined (no project config exists).
 */
export function getProjectBaseDir(cwd: string): string {
	return join(cwd, DRYKISS_BASE_DIR);
}

/**
 * Get the project config path. Unlike getGlobalBaseDir which always
 * returns a valid path, the project config only exists if the user
 * has created one (e.g. via /drykiss-suppress).
 */
export function getProjectConfigPath(cwd: string): string {
	return join(getProjectBaseDir(cwd), CONFIG_FILE);
}

/** Subdirectories */
export const CONFIG_DIR = DRYKISS_BASE_DIR;
export const PROMPTS_DIR = join(DRYKISS_BASE_DIR, "prompts");
export const REVIEWS_DIR = join(DRYKISS_BASE_DIR, "reviews");

/** File names */
export const CONFIG_FILE = "config.json";

/** Human-readable lens display names. */
export const LENS_DISPLAY_NAMES: Record<string, string> = {
	simplicity: "KISS",
	deduplication: "DRY",
	clarity: "Clarity",
	resilience: "Resilience",
	architecture: "Architecture",
	tests: "Tests",
	security: "Security",
	synthesis: "Synthesis",
};

/** Log prefix for all DRYKISS console output */
export const LOG_PREFIX = "[DRYKISS]";

/** Known severity values used for validation and overrides. */
export const SEVERITY_VALUES: ReadonlySet<string> = new Set([
	"critical",
	"high",
	"medium",
	"low",
	"nit",
]);
