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

/** Subdirectories */
export const CONFIG_DIR = DRYKISS_BASE_DIR;
export const PROMPTS_DIR = join(DRYKISS_BASE_DIR, "prompts");
export const REVIEWS_DIR = join(DRYKISS_BASE_DIR, "reviews");

/** File names */
export const CONFIG_FILE = "config.json";
