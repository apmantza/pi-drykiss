import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalBaseDir, CONFIG_FILE } from "./constants.js";
import { VALID_RISK_CODES } from "./prompts/risk-codes.js";

// ── Risk-code targeting types (Phase 2) ─────────────────────────────────

/** A risk code as used in config: one of the codes from RISK_CODES. */
export type RiskCode =
	keyof typeof import("./prompts/risk-codes.js").RISK_CODES;

/** A severity value, accepting all five DRYKISS levels. */
export type SeverityOverride = "critical" | "high" | "medium" | "low" | "nit";

/** Severity override rule: when a finding's riskCode matches, override its severity. */
export interface SeverityOverrideRule {
	readonly riskCode: string;
	readonly to: SeverityOverride;
}

/** Glob pattern for `ignore` — same syntax as gitignore. */
export type IgnorePattern = string;

/** Per-project config (Phase 2) for risk-code targeting. */
export interface RiskTargeting {
	/**
	 * Disable specific risk codes — findings with these riskCodes are
	 * stripped from the result entirely. Cannot be combined with `focus`.
	 */
	readonly disable?: readonly string[];
	/**
	 * Override the severity of findings matching specific risk codes.
	 * Use to downgrade a known-acceptable code (e.g. legacy duplication)
	 * or upgrade a default-nip to a blocker (e.g. clarity on a public API).
	 */
	readonly severity?: readonly SeverityOverrideRule[];
	/**
	 * Ignore findings in files matching these glob patterns. File match
	 * is done against the normalized repo-relative path. Same syntax as
	 * gitignore (`**`, `*`, `?`).
	 */
	readonly ignore?: readonly IgnorePattern[];
	/**
	 * Focus on specific risk codes — only findings with these riskCodes
	 * pass through. The other codes' findings are stripped. Cannot be
	 * combined with `disable` (when both are set, both are ignored and a
	 * warning is emitted).
	 */
	readonly focus?: readonly string[];
}

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
	/** Risk-code targeting (Phase 2). */
	riskTargeting?: RiskTargeting;
	/** Automatic closeout review configuration. */
	autoreview?: DrykissAutoreviewConfig;
}

export function getConfigPath(): string {
	return join(getGlobalBaseDir(), CONFIG_FILE);
}

export async function loadConfig(): Promise<DrykissConfig> {
	const { config } = await loadEffectiveConfig();
	return config;
}

/**
 * Load and validate the config. Returns the cleaned config plus a list
 * of validation warnings. The caller can display warnings (e.g. in the
 * TUI widget) without having to re-implement validation.
 *
 * Validation rules (Phase 2):
 *   - Unknown risk code in `disable`/`focus` → warn, drop the unknown code
 *   - Unknown risk code in `severity[*].riskCode` → warn, drop the rule
 *   - Both `disable` and `focus` non-empty → ignore both, warn
 *   - Invalid severity value → warn, drop the rule
 *
 * Defaults are returned when the file is missing or corrupt (matching
 * the original loadConfig behaviour).
 */
export async function loadEffectiveConfig(): Promise<{
	config: DrykissConfig;
	warnings: string[];
}> {
	const warnings: string[] = [];
	let raw: DrykissConfig;
	try {
		const text = await readFile(getConfigPath(), "utf8");
		raw = JSON.parse(text) as DrykissConfig;
	} catch (err) {
		if (
			err instanceof Error &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return {
				config: { interactive: true, confirmBeforeRun: true },
				warnings: [],
			};
		}
		if (err instanceof SyntaxError) {
			console.warn("[DRYKISS] Config file is corrupt, using defaults");
			return {
				config: { interactive: true, confirmBeforeRun: true },
				warnings: ["Config file is corrupt; defaults applied."],
			};
		}
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[DRYKISS] Failed to load config:", msg);
		throw err;
	}

	if (!raw.riskTargeting) {
		return { config: raw, warnings };
	}

	const rt = raw.riskTargeting;
	const cleaned: {
		disable?: string[];
		severity?: SeverityOverrideRule[];
		ignore?: string[];
		focus?: string[];
	} = {};

	if (rt.disable !== undefined) {
		const { valid, dropped } = partitionByRiskCode(rt.disable);
		cleaned.disable = valid;
		for (const code of dropped) {
			warnings.push(`Unknown risk code in disable: ${code}`);
		}
	}

	if (rt.focus !== undefined) {
		const { valid, dropped } = partitionByRiskCode(rt.focus);
		cleaned.focus = valid;
		for (const code of dropped) {
			warnings.push(`Unknown risk code in focus: ${code}`);
		}
	}

	if (cleaned.disable && cleaned.focus) {
		warnings.push(
			"Both disable and focus are set; ignoring both. Use one or the other.",
		);
		cleaned.disable = undefined;
		cleaned.focus = undefined;
	}

	if (rt.severity !== undefined) {
		const validRules: SeverityOverrideRule[] = [];
		for (const rule of rt.severity) {
			if (!isValidRiskCode(rule.riskCode)) {
				warnings.push(
					`Unknown risk code in severity override: ${rule.riskCode}`,
				);
				continue;
			}
			if (!isValidSeverity(rule.to)) {
				warnings.push(
					`Invalid severity "${String(rule.to)}" for ${rule.riskCode}`,
				);
				continue;
			}
			validRules.push({ riskCode: rule.riskCode, to: rule.to });
		}
		cleaned.severity = validRules;
	}

	if (rt.ignore !== undefined) {
		cleaned.ignore = rt.ignore.filter(
			(p) => typeof p === "string" && p.length > 0,
		);
	}

	return {
		config: {
			...raw,
			riskTargeting: {
				...(cleaned.disable ? { disable: cleaned.disable } : {}),
				...(cleaned.severity ? { severity: cleaned.severity } : {}),
				...(cleaned.ignore ? { ignore: cleaned.ignore } : {}),
				...(cleaned.focus ? { focus: cleaned.focus } : {}),
			},
		},
		warnings,
	};
}

function isValidRiskCode(code: string): boolean {
	return VALID_RISK_CODES.has(code);
}

function isValidSeverity(s: unknown): s is SeverityOverride {
	return (
		s === "critical" ||
		s === "high" ||
		s === "medium" ||
		s === "low" ||
		s === "nit"
	);
}

function partitionByRiskCode(codes: readonly string[]): {
	valid: string[];
	dropped: string[];
} {
	const valid: string[] = [];
	const dropped: string[] = [];
	for (const code of codes) {
		if (isValidRiskCode(code)) valid.push(code);
		else dropped.push(code);
	}
	return { valid, dropped };
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
