import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
    synthesis?: string;
  };
  /** Whether to prompt for model selection on first use */
  interactive?: boolean;
  /** Whether to ask for confirmation before running reviews */
  confirmBeforeRun?: boolean;
  /** Context mode: "diff" = changed hunks only, "full" = full file + diff (default) */
  contextMode?: "diff" | "full";
}

const CONFIG_DIR = ".pi/drykiss";
const CONFIG_FILE = "config.json";

export function getConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export async function loadConfig(cwd: string): Promise<DrykissConfig> {
  try {
    const raw = await readFile(getConfigPath(cwd), "utf8");
    return JSON.parse(raw) as DrykissConfig;
  } catch {
    return { interactive: true, confirmBeforeRun: true };
  }
}

export async function saveConfig(cwd: string, config: DrykissConfig): Promise<void> {
  const dir = join(cwd, CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(getConfigPath(cwd), JSON.stringify(config, null, 2), "utf8");
}

export async function setLensModel(
  cwd: string,
  lens: string,
  model: string,
): Promise<void> {
  const config = await loadConfig(cwd);
  config.lensModels = { ...config.lensModels, [lens]: model };
  await saveConfig(cwd, config);
}

export async function setDefaultModel(
  cwd: string,
  model: string,
): Promise<void> {
  const config = await loadConfig(cwd);
  config.defaultModel = model;
  await saveConfig(cwd, config);
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
