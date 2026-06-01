import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalBaseDir, CONFIG_FILE } from "./constants.js";

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
			console.error("[DRYKISS] Config file is corrupt, using defaults");
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
