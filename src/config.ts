import { mkdir, readFile, writeFile, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import {
	getGlobalBaseDir,
	getProjectBaseDir,
	getProjectConfigPath,
	CONFIG_FILE,
	SEVERITY_VALUES,
	LOG_PREFIX,
	getNodeErrorCode,
} from "./constants.js";
import { toErrorMessage } from "./error-utils.js";
import { assertPathInRoot } from "./path-utils.js";
import { isPlainObject } from "./json-utils.js";
import { VALID_RISK_CODES } from "./prompts/risk-codes.js";
import { LENS_NAMES, type ReviewLens, type AnyLens, isAnyLens } from "./types.js";
import type { FindingBudget } from "./finding-budget.js";

// ── Suppression types (Phase 3) ─────────────────────────────────────────

/** A single suppression entry stored in the per-project config. */
export interface Suppression {
	/** Unique ID for this suppression (auto-generated). */
	readonly id: string;
	/**
	 * Risk code to suppress (e.g. "K1", "D1", or "*" for all codes).
	 * When "*", any finding matching the `pattern` glob is suppressed.
	 */
	readonly riskCode: string;
	/**
	 * Glob pattern matching files to suppress.
	 * Same syntax as gitignore (`**`, `*`, `?`).
	 */
	readonly pattern: string;
	/** Human-readable reason for the suppression. */
	readonly reason: string;
	/** ISO 8601 timestamp when this suppression was added. */
	readonly addedAt: string;
	/**
	 * Optional ISO 8601 expiry date. After this date, the suppression
	 * is ignored and the finding resurfaces. When undefined, the
	 * suppression never expires.
	 */
	readonly expiresAt?: string;
}

/** A severity value, accepting all five DRYKISS levels. */
export type SeverityOverride = "critical" | "high" | "medium" | "low" | "nit";

/** Commands that the review pipeline can run to ground findings in reality. */
export interface DrykissCommands {
	/** Test command used by the tests lens to validate behavior. */
	readonly test?: string;
	/** Lint command used by the tests/clarity lens to check style. */
	readonly lint?: string;
}

/** Severity override rule: when a finding's riskCode matches, override its severity. */
export interface SeverityOverrideRule {
	readonly riskCode: string;
	readonly to: SeverityOverride;
}

/** Glob pattern for `ignore` — same syntax as gitignore. */
export type IgnorePattern = string;

export interface ReviewPathInstruction {
	readonly glob: string;
	readonly instruction: string;
	/** Built-in or custom lens names this instruction applies to. When absent, applies to all lenses. */
	readonly lenses?: readonly AnyLens[];
}

export interface ReviewPathFilters {
	readonly exclude?: readonly string[];
	readonly forceInclude?: readonly string[];
}

export interface ReviewPolicyConfig {
	readonly pathFilters?: ReviewPathFilters;
	readonly pathInstructions?: readonly ReviewPathInstruction[];
	readonly findingBudget?: FindingBudget;
}

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

export interface ScoutConfig {
	/**
	 * When true, the scout stage runs before full-codebase reviews to map
	 * the project and narrow the file list. Defaults to false.
	 */
	readonly enabled?: boolean;
	/**
	 * Maximum files the scout should select. The review's own maxFiles cap
	 * still applies afterward. Defaults to 40.
	 */
	readonly maxFiles?: number;
	/**
	 * Glob patterns for docs the scout should read. Defaults to a standard
	 * set (README.md, AGENTS.md, claude.md, package.json, etc.).
	 */
	readonly docs?: string[];
}

export interface DrykissAutoreviewConfig {
	/** Opt-in automatic review at agent_end after code edits. Disabled by default. */
	enabled?: boolean;
	/** Scope mode to review when agent_end fires. Defaults to local dirty diff. */
	mode?: "local" | "staged" | "branch" | "full" | "files";
	/** Base ref for branch-mode autoreviews. */
	base?: string;
	/** Lens subset to run. Defaults to all lenses. May include custom lens names. */
	lenses?: Array<AnyLens>;
	/** Maximum files reviewed per autoreview run. Defaults to 40. */
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
	/**
	 * When true, automatically post review findings back to the GitHub PR as
	 * a pull-request review after a PR-mode (`mode: "pr"`) review completes.
	 * Requires the `gh` CLI to be authenticated. The verdict (approve /
	 * request_changes / comment) is derived from the synthesis result.
	 *
	 * Default: false.
	 */
	postToPr?: boolean;
	/** Per-lens model overrides, including the scout pre-flight stage. */
	lensModels?: {
		simplicity?: string;
		deduplication?: string;
		clarity?: string;
		resilience?: string;
		architecture?: string;
		tests?: string;
		security?: string;
		synthesis?: string;
		validator?: string;
		scout?: string;
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
	/**
	 * Scout-stage configuration for full-codebase reviews. When enabled, the
	 * scout maps the project and selects the most important files before the
	 * review lenses run.
	 */
	scout?: ScoutConfig;
	/** Risk-code targeting (Phase 2). */
	riskTargeting?: RiskTargeting;
	/** Suppressions (Phase 3) — stored in per-project config. */
	suppressions?: Suppression[];
	/** Automatic closeout review configuration. */
	autoreview?: DrykissAutoreviewConfig;
	/** Supplemental review policy, including path-specific guidance. */
	review?: ReviewPolicyConfig;
	/**
	 * Minimum health score threshold for the quality gate (0-100).
	 * Reviews with score below this value show a FAIL indicator.
	 * Default: 70.
	 */
	qualityGate?: number;
	/**
	 * Glob patterns for files that should be excluded from the review scope
	 * entirely (e.g., generated files, vendored code). Same syntax as
	 * gitignore (`**`, `*`, `?`). Matches against repo-relative paths.
	 */
	ignorePatterns?: readonly string[];
	/**
	 * Optional commands the review pipeline can use to validate findings.
	 * The tests lens will prefer these when available.
	 */
	commands?: DrykissCommands;
	/**
	 * Run the selective validator stage (see ./validator.ts). It is enabled
	 * by default; set this to false only for an explicitly latency-sensitive
	 * review. Validator-refuted findings are retained separately for audit but
	 * excluded from active counts, risk, and quality-gate evaluation.
	 */
	validate?: boolean;
	/**
	 * Maximum number of lens subagents to run in parallel.
	 * Higher values reduce wall-clock review time at the cost of more
	 * simultaneous API calls. Must be between 1 and 10. Default: 3.
	 */
	concurrency?: number;
	/**
	 * Lenses that run in Bugbot-style deep mode (multi-pass adversarial +
	 * validator) instead of the standard single-pass flow. Defaults to
	 * `["security"]` when omitted. Set to `[]` or use `deep: false` to
	 * disable deep mode entirely.
	 *
	 * Valid values are the named DRYKISS lens names (excluding "all").
	 */
	deepLenses?: Exclude<ReviewLens, "all">[];
	/**
	 * Master on/off switch for the deep-review pipeline. When `false`,
	 * all lenses run as standard single-pass reviews regardless of
	 * `deepLenses`. Equivalent to passing `--no-deep` at the CLI.
	 * Defaults to `true`.
	 */
	deep?: boolean;
}

function getConfigPath(): string {
	return join(getGlobalBaseDir(), CONFIG_FILE);
}

export async function loadConfig(): Promise<DrykissConfig> {
	const { config, warnings } = await loadEffectiveConfig();
	for (const warning of warnings) {
		console.warn(`${LOG_PREFIX} ${warning}`);
	}
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
/** Default config values used when no config file exists. */
const DEFAULT_CONFIG: Pick<
	DrykissConfig,
	"interactive" | "confirmBeforeRun" | "autoreview" | "review" | "scout"
> = {
	interactive: true,
	confirmBeforeRun: true,
	autoreview: { maxFiles: 40 },
	review: {},
	scout: { enabled: false },
};

/**
 * Deduplicate suppression entries by id (preferred) or by riskCode+pattern.
 * Later entries with the same key overwrite earlier ones (project overrides global).
 */
function deduplicateSuppressions(
	suppressions: readonly Suppression[],
): Suppression[] {
	const seen = new Set<string>();
	const result: Suppression[] = [];
	// Iterate in reverse so later entries (project config) take precedence
	for (let i = suppressions.length - 1; i >= 0; i--) {
		const s = suppressions[i];
		const key = s.id ?? `${s.riskCode}:${s.pattern}`;
		if (!seen.has(key)) {
			seen.add(key);
			result.unshift(s);
		}
	}
	return result;
}

export async function loadEffectiveConfig(
	cwd?: string,
): Promise<{ config: DrykissConfig; warnings: string[] }> {
	const warnings: string[] = [];
	const globalConfig = await loadConfigFile(getConfigPath(), warnings);
	let config: DrykissConfig = globalConfig ?? DEFAULT_CONFIG;
	if (cwd) {
		const projectPath = getProjectConfigPath(cwd);
		const projectConfig = await loadConfigFile(projectPath, warnings);
		if (projectConfig) {
			const baseConfig = globalConfig ?? DEFAULT_CONFIG;
			config = {
				...baseConfig,
				...projectConfig,
				autoreview: {
					...DEFAULT_CONFIG.autoreview,
					...baseConfig.autoreview,
					...projectConfig.autoreview,
				},
				scout: {
					...DEFAULT_CONFIG.scout,
					...baseConfig.scout,
					...projectConfig.scout,
				},
				review: {
					...baseConfig.review,
					...projectConfig.review,
					pathInstructions: [
						...(baseConfig.review?.pathInstructions ?? []),
						...(projectConfig.review?.pathInstructions ?? []),
					],
				},
				suppressions: deduplicateSuppressions([
					...(globalConfig?.suppressions ?? []),
					...(projectConfig.suppressions ?? []),
				]),
			};
		}
	}
	const rt = config.riskTargeting;
	const cleaned: {
		disable?: string[];
		severity?: SeverityOverrideRule[];
		ignore?: string[];
		focus?: string[];
	} = {};
	if (rt?.disable !== undefined) {
		const { valid, dropped } = partitionByRiskCode(rt.disable);
		cleaned.disable = valid;
		for (const code of dropped) {
			warnings.push(`Unknown risk code in disable: ${code}`);
		}
	}
	if (rt?.focus !== undefined) {
		const { valid, dropped } = partitionByRiskCode(rt.focus);
		cleaned.focus = valid;
		for (const code of dropped) {
			warnings.push(`Unknown risk code in focus: ${code}`);
		}
	}
	if (cleaned.disable?.length && cleaned.focus?.length) {
		warnings.push(
			"Both disable and focus are set; ignoring both. Use one or the other.",
		);
		cleaned.disable = undefined;
		cleaned.focus = undefined;
	}
	if (rt?.severity !== undefined) {
		const validRules: SeverityOverrideRule[] = [];
		for (const rule of rt?.severity ?? []) {
			if (!VALID_RISK_CODES.has(rule.riskCode)) {
				warnings.push(
					`Unknown risk code in severity override: ${rule.riskCode}`,
				);
				continue;
			}
			if (!isValidSeverity(rule.to)) {
				warnings.push(
					`Invalid severity "${String(rule.to)}" for ${rule.riskCode} — valid values are: ${[...SEVERITY_VALUES].join(", ")}`,
				);
				continue;
			}
			validRules.push({ riskCode: rule.riskCode, to: rule.to });
		}
		cleaned.severity = validRules;
	}
	if (rt?.ignore !== undefined) {
		cleaned.ignore = rt.ignore.filter(
			(p) => typeof p === "string" && p.length > 0,
		);
	}

	const cleanedIgnorePatterns = Array.isArray(config.ignorePatterns)
		? config.ignorePatterns.filter(isNonEmptyString)
		: undefined;
	const cleanedCommands = isPlainObject(config.commands)
		? Object.fromEntries(
				Object.entries(config.commands)
					.filter(([, v]) => isNonEmptyString(v))
					.filter(([k]) => k === "test" || k === "lint"),
			)
		: undefined;
	const cleanedReview = cleanReviewPolicy(config.review);
	const cleanedScout = cleanScoutConfig(config.scout);
	const cleanedConcurrency = cleanConcurrency(config.concurrency, warnings);
	const { cleanedDeepLenses, cleanedDeep } = cleanDeepConfig(
		config.deepLenses,
		config.deep,
		warnings,
	);

	return {
		config: {
			...config,
			autoreview: {
				...DEFAULT_CONFIG.autoreview,
				...config.autoreview,
			},
			scout: {
				...DEFAULT_CONFIG.scout,
				...config.scout,
				...cleanedScout,
			},
			...(rt
				? {
						riskTargeting: {
							...(cleaned.disable ? { disable: cleaned.disable } : {}),
							...(cleaned.severity ? { severity: cleaned.severity } : {}),
							...(cleaned.ignore ? { ignore: cleaned.ignore } : {}),
							...(cleaned.focus ? { focus: cleaned.focus } : {}),
						},
					}
				: {}),
			ignorePatterns: cleanedIgnorePatterns,
			commands: cleanedCommands,
			review: cleanedReview,
			...(cleanedConcurrency !== undefined
				? { concurrency: cleanedConcurrency }
				: {}),
			...(cleanedDeepLenses !== undefined
				? { deepLenses: cleanedDeepLenses }
				: {}),
			...(cleanedDeep !== undefined ? { deep: cleanedDeep } : {}),
		},
		warnings,
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function cleanReviewPolicy(value: unknown): ReviewPolicyConfig | undefined {
	if (!isPlainObject(value)) return undefined;
	const rawInstructions = value.pathInstructions;
	const pathFilters = cleanPathFilters(value.pathFilters);
	const findingBudget = cleanFindingBudget(value.findingBudget);
	if (!Array.isArray(rawInstructions)) {
		return {
			...(pathFilters ? { pathFilters } : {}),
			...(findingBudget ? { findingBudget } : {}),
		};
	}

	const pathInstructions: ReviewPathInstruction[] = [];
	for (const raw of rawInstructions) {
		if (!isPlainObject(raw)) continue;
		if (!isNonEmptyString(raw.glob) || !isNonEmptyString(raw.instruction)) {
			continue;
		}
		const lenses = Array.isArray(raw.lenses)
			? raw.lenses.filter(isAnyLens)
			: undefined;
		pathInstructions.push({
			glob: raw.glob,
			instruction: raw.instruction,
			...(lenses && lenses.length > 0 ? { lenses } : {}),
		});
	}
	return {
		...(pathFilters ? { pathFilters } : {}),
		...(findingBudget ? { findingBudget } : {}),
		pathInstructions,
	};
}

function cleanFindingBudget(value: unknown): FindingBudget | undefined {
	if (!isPlainObject(value)) return undefined;
	const maxFindings = isNonNegativeInteger(value.maxFindings)
		? value.maxFindings
		: undefined;
	const maxNits = isNonNegativeInteger(value.maxNits)
		? value.maxNits
		: undefined;
	return maxFindings === undefined && maxNits === undefined
		? undefined
		: {
				...(maxFindings !== undefined ? { maxFindings } : {}),
				...(maxNits !== undefined ? { maxNits } : {}),
			};
}

function cleanScoutConfig(value: unknown): ScoutConfig | undefined {
	if (!isPlainObject(value)) return undefined;
	const enabled =
		typeof value.enabled === "boolean" ? value.enabled : undefined;
	const maxFiles = isNonNegativeInteger(value.maxFiles)
		? value.maxFiles
		: undefined;
	const docs = Array.isArray(value.docs)
		? value.docs.filter(isNonEmptyString)
		: undefined;
	if (enabled === undefined && maxFiles === undefined && docs === undefined) {
		return undefined;
	}
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(maxFiles !== undefined ? { maxFiles } : {}),
		...(docs !== undefined ? { docs } : {}),
	};
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 10;

function cleanConcurrency(
	value: unknown,
	warnings: string[],
): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < CONCURRENCY_MIN ||
		value > CONCURRENCY_MAX
	) {
		warnings.push(
			`Invalid concurrency value "${String(value)}"; must be an integer between ${CONCURRENCY_MIN} and ${CONCURRENCY_MAX}. Using default (3).`,
		);
		return undefined;
	}
	return value;
}

/** Validate `deepLenses` and `deep` config fields.
 *  - `deepLenses`: filter out non-lens-name values and warn.
 *  - `deep`: must be boolean; non-boolean is ignored with a warning.
 *  Returns `undefined` for each field if it should be omitted from the
 *  cleaned config (i.e. the field was absent or entirely invalid). */
function cleanDeepConfig(
	deepLenses: unknown,
	deep: unknown,
	warnings: string[],
): {
	cleanedDeepLenses: Exclude<ReviewLens, "all">[] | undefined;
	cleanedDeep: boolean | undefined;
} {
	let cleanedDeepLenses: Exclude<ReviewLens, "all">[] | undefined;
	if (deepLenses !== undefined) {
		if (!Array.isArray(deepLenses)) {
			warnings.push(
				`Invalid deepLenses value; must be an array of lens names. Using default (["security"]).`,
			);
		} else {
			const valid: Exclude<ReviewLens, "all">[] = [];
			for (const item of deepLenses) {
				// isReviewLens checks against LENS_NAMES (which excludes "all"),
				// so items that pass are safely Exclude<ReviewLens, "all">.
				if (isReviewLens(item)) {
					valid.push(item as Exclude<ReviewLens, "all">);
				} else {
					warnings.push(
						`Unknown lens name "${String(item)}" in deepLenses; ignoring.`,
					);
				}
			}
			cleanedDeepLenses = valid;
		}
	}

	let cleanedDeep: boolean | undefined;
	if (deep !== undefined) {
		if (typeof deep !== "boolean") {
			warnings.push(
				`Invalid deep value "${String(deep)}"; must be a boolean. Ignoring.`,
			);
		} else {
			cleanedDeep = deep;
		}
	}

	return { cleanedDeepLenses, cleanedDeep };
}

function cleanPathFilters(value: unknown): ReviewPathFilters | undefined {
	if (!isPlainObject(value)) return undefined;
	const exclude = Array.isArray(value.exclude)
		? value.exclude.filter(isNonEmptyString)
		: undefined;
	const forceInclude = Array.isArray(value.forceInclude)
		? value.forceInclude.filter(isNonEmptyString)
		: undefined;
	return exclude || forceInclude
		? {
				...(exclude ? { exclude } : {}),
				...(forceInclude ? { forceInclude } : {}),
			}
		: undefined;
}

function isReviewLens(value: unknown): value is ReviewLens {
	return (
		typeof value === "string" &&
		LENS_NAMES.includes(value as Exclude<ReviewLens, "all">)
	);
}
async function loadConfigFile(
	path: string,
	warnings: string[],
): Promise<DrykissConfig | undefined> {
	try {
		const text = await readFile(path, "utf8");
		const parsed = JSON.parse(text) as unknown;
		// Reject non-object / array JSON so a malformed top-level value
		// (a bare string, number, or array) can't be silently trusted as a
		// config object.
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			warnings.push(`Config file ${path} is not a JSON object; ignoring.`);
			return undefined;
		}
		return parsed as DrykissConfig;
	} catch (err) {
		// ENOENT is expected (no config yet). Any other error (corrupt,
		// permission, disk) degrades to "no config" rather than breaking the
		// review — best-effort, like the rest of the tool.
		if (getNodeErrorCode(err) === "ENOENT") return undefined;
		warnings.push(
			`Failed to load config ${path}: ${toErrorMessage(err)}; ignoring.`,
		);
		return undefined;
	}
}
function isValidSeverity(s: unknown): s is SeverityOverride {
	return typeof s === "string" && SEVERITY_VALUES.has(s);
}

function partitionByRiskCode(codes: readonly string[]): {
	valid: string[];
	dropped: string[];
} {
	const valid: string[] = [];
	const dropped: string[] = [];
	for (const code of codes) {
		if (VALID_RISK_CODES.has(code)) valid.push(code);
		else dropped.push(code);
	}
	return { valid, dropped };
}

export async function saveConfig(config: DrykissConfig): Promise<void> {
	const dir = getGlobalBaseDir();
	await mkdir(dir, { recursive: true });
	await writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

/**
 * Save a project-local config. Only writes the fields relevant to the
 * project config (suppressions). The project config is a partial
 * DrykissConfig that gets merged on top of the global config.
 */
export async function saveProjectConfig(
	cwd: string,
	projectConfig: Pick<DrykissConfig, "suppressions">,
): Promise<void> {
	const path = getProjectConfigPath(cwd);
	const dir = getProjectBaseDir(cwd);

	// Defensive: ensure the resolved path stays within the project directory.
	// We create the directory, then open it with O_NOFOLLOW so a symlink swap
	// after mkdir cannot be followed. fstat on the fd confirms it is a directory,
	// and realpath+assertPathInRoot confirms the final resolved path stays in root.
	const cwdResolved = await realpath(resolve(cwd));
	await mkdir(dir, { recursive: true });

	let fd: import("node:fs/promises").FileHandle | undefined;
	try {
		fd = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = await fd.stat();
		if (!stats.isDirectory()) {
			throw new Error(
				`Project config directory is not a regular directory: ${dir}`,
			);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(
				`Project config directory is a symlink (possible attack): ${dir}`,
			);
		}
		throw err;
	} finally {
		await fd?.close();
	}

	const resolvedDir = await realpath(dir);
	assertPathInRoot(resolvedDir, cwdResolved);

	// Read existing project config first to preserve other fields
	let existing: DrykissConfig = {};
	const warnings: string[] = [];
	const loaded = await loadConfigFile(path, warnings);
	if (loaded) existing = loaded;
	for (const warning of warnings) {
		console.warn(`${LOG_PREFIX} ${warning}`);
	}
	await writeFile(
		path,
		JSON.stringify(
			{ ...existing, suppressions: projectConfig.suppressions },
			null,
			2,
		),
		"utf8",
	);
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
