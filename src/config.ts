import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalBaseDir, CONFIG_FILE } from "./constants.js";

export interface DrykissAutoreviewConfig {
	/** Opt-in automatic review at agent_end after code edits. Disabled by default. */
	enabled?: boolean;
	/** Scope mode to review when agent_end fires. Defaults to local dirty diff. */
	mode?: "local" | "staged" | "branch" | "full" | "files";
	/** Base ref for branch-mode autoreviews. */
	base?: string;
	/** Lens subset to run. Defaults to all lenses. */
	lenses?: Array<
		| "simplicity"
		| "deduplication"
		| "clarity"
		| "resilience"
		| "architecture"
		| "tests"
		| "security"
	>;
	/** Maximum files allowed for automatic review. Defaults to 20. */
	maxFiles?: number;
	/** Override context mode for automatic reviews. */
	contextMode?: "diff" | "full";
	/** Optional model hint for automatic reviews. */
	model?: string;
	/** Ask for confirmation before running automatic reviews in UI sessions. Defaults to true. */
	confirmBeforeRun?: boolean;
	/** Cooldown for identical automatic review scopes. Defaults to 60000ms. */
	cooldownMs?: number;
}

export interface DrykissConfig {
	/** Default model for all lenses when not specified */
	defaultModel?: string;
	/** Per-lens model overrides */
	lensModels?: {
		simplicity?: string;
		deduplication?: string;
		clarity?: string;
		resilience?: string;
		architecture?: string;
		tests?: string;
		security?: string;
		synthesis?: string;
	};
	/** Whether to prompt for model selection on first use */
	interactive?: boolean;
	/** Whether to ask for confirmation before running reviews */
	confirmBeforeRun?: boolean;
	/** Context mode: "diff" = changed hunks only, "full" = full file + diff (default) */
	contextMode?: "diff" | "full";
	/**
	 * Auto-route to free models instead of showing the model selection popup.
	 * When true, pi-drykiss will try to find a free model that matches
	 * `modelScope` first, then any free model, before falling back to the
	 * popup (or the first available model in headless mode).
	 */
	autoroute?: boolean;
	/**
	 * Free-text scope hint for auto-routing. Matched against model id/name
	 * using the same substring rules as the `--model` flag.
	 *
	 * Single-hint form (legacy):
	 *   "claude"  — any free Claude model
	 *   "haiku"   — any free model whose id/name contains "haiku"
	 *   "minimax" — any free model whose id/name contains "minimax"
	 *
	 * List form (preference order):
	 *   ["minimax", "deepseek-v4-flash", "kimi", "step-flash"]
	 *
	 * When a list is supplied, hints are tried in order and the first
	 * matching free model wins. If none of the listed hints match, the
	 * caller falls back to "any free model" (preserving the single-hint
	 * behaviour). This shape exists for users who want to restrict auto-
	 * routing to a curated set of preferred providers without writing a
	 * per-lens override for every lens.
	 *
	 * If unset (or no scoped match is found), any free model is used.
	 */
	modelScope?: string | string[];
	/** Automatic closeout review configuration. */
	autoreview?: DrykissAutoreviewConfig;
}

export function getConfigPath(): string {
	return join(getGlobalBaseDir(), CONFIG_FILE);
}

export async function loadConfig(): Promise<DrykissConfig> {
	try {
		const raw = await readFile(getConfigPath(), "utf8");
		return JSON.parse(raw) as DrykissConfig;
	} catch (err) {
		// ENOENT: file missing — return defaults silently (new project)
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return { interactive: true, confirmBeforeRun: true };
		}
		// JSON parse error: corrupt file — warn and fall back to defaults
		// Note: Don't log err.message as it may contain the malformed JSON content
		if (err instanceof SyntaxError) {
			console.warn("[DRYKISS] Config file is corrupt, using defaults");
			return { interactive: true, confirmBeforeRun: true };
		}
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[DRYKISS] Failed to load config:", msg);
		throw err;
	}
}

export async function saveConfig(config: DrykissConfig): Promise<void> {
	const dir = getGlobalBaseDir();
	await mkdir(dir, { recursive: true });
	await writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

export async function setLensModel(lens: string, model: string): Promise<void> {
	const config = await loadConfig();
	config.lensModels = { ...config.lensModels, [lens]: model };
	await saveConfig(config);
}

export async function setDefaultModel(model: string): Promise<void> {
	const config = await loadConfig();
	config.defaultModel = model;
	await saveConfig(config);
}

export function getModelForLens(
	config: DrykissConfig,
	lens?: string,
): string | undefined {
	if (lens && config.lensModels?.[lens as keyof typeof config.lensModels]) {
		return config.lensModels[lens as keyof typeof config.lensModels];
	}
	return config.defaultModel;
}
