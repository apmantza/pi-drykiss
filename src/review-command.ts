import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { buildReviewPrompts, ensureDefaultPrompts } from "./prompt-builder.js";

import { type loadConfig, loadEffectiveConfig } from "./config.js";
import { buildActiveConstraints } from "./active-constraints.js";
import { findModelByHint } from "./llm.js";
import type {
	ReviewLens,
	ReviewOptions,
	ChangedFile,
	Finding,
	Severity,
} from "./types.js";
import { LENS_NAMES } from "./types.js";
import { parseFindingsJson } from "./parse-findings.js";
import { isPrReference, type PrInfo } from "./github-pr.js";
import {
	applyReviewState,
	returnFromReviewSession,
	setReviewInProgress,
	startReviewSession,
} from "./review-session.js";
import { resolveSmartDefault } from "./smart-default.js";
import {
	resolveReviewScope,
	type ReviewMode,
	type ReviewScope,
} from "./review-scope.js";
import type { ReviewJob } from "./review-manager.js";
import type { ReviewResult } from "./review-result.js";
import { filterIgnored } from "./review-result.js";
import { formatReviewResultCompact } from "./compact-format.js";
import { LOG_PREFIX } from "./constants.js";
import { toErrorMessage } from "./error-utils.js";

export const COMMAND_NAME = "drykiss";
export const KISS_COMMAND_NAME = "drykiss-kiss";
export const DRY_COMMAND_NAME = "drykiss-dry";
export const RESILIENCE_COMMAND_NAME = "drykiss-resilience";
export const ARCH_COMMAND_NAME = "drykiss-arch";
export const TESTS_COMMAND_NAME = "drykiss-tests";
export const SECURITY_COMMAND_NAME = "drykiss-security";

const MAX_FILES = 20;

export interface ParsedArgs extends ReviewOptions {
	readonly model?: string;
	/** PR reference if reviewing a GitHub PR */
	readonly pr?: PrInfo;
	/** Whether to start an isolated review branch */
	readonly branch?: boolean;
	/** Whether --ref was explicitly provided */
	readonly explicitRef?: boolean;
	/** Run the validator stage (default: false; see config.validate) */
	readonly validate?: boolean;
}

export function tokenizeArgs(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < value.length; i++) {
		const char = value[i];

		if (quote) {
			if (char === "\\" && i + 1 < value.length) {
				current += value[i + 1];
				i += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (char === "\\" && i + 1 < value.length) {
			current += value[i + 1];
			i += 1;
			continue;
		}

		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (quote) {
		throw new Error(`Unmatched ${quote} quote in arguments.`);
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}

export function parseArgs(args: string): ParsedArgs {
	const tokens = tokenizeArgs(args.trim());
	const files: string[] = [];
	let ref = "HEAD";
	let staged = false;
	let all = false;
	let model: string | undefined;
	let pr: PrInfo | undefined;
	let branch = false;
	let explicitRef = false;
	let validate = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--staged") {
			staged = true;
		} else if (token === "--all") {
			all = true;
		} else if (token === "--validate") {
			validate = true;
		} else if (token === "--ref") {
			const value = tokens[i + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--ref requires a value.");
			}
			explicitRef = true;
			ref = value;
			i += 1;
		} else if (token.startsWith("--ref=")) {
			explicitRef = true;
			ref = token.slice("--ref=".length);
		} else if (token === "--model") {
			const value = tokens[i + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--model requires a value.");
			}
			model = value;
			i += 1;
		} else if (token.startsWith("--model=")) {
			model = token.slice("--model=".length);
		} else if (token === "--branch") {
			branch = true;
		} else if (isPrReference(token)) {
			// Will be resolved in prepareReview after we get the git remote
			pr = { owner: "", repo: "", number: 0, _raw: token } as PrInfo & {
				_raw: string;
			};
		} else {
			files.push(token);
		}
	}

	return { files, ref, staged, all, model, pr, branch, explicitRef, validate };
}

/**
 * Common review setup: parses args, gathers files, diffs, contents, and project index.
 * Shared between handleDrykissCommand and handleSingleLensCommand.
 */
async function prepareReview(
	argsOrOptions: string | ParsedArgs,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	needsProjectIndex: boolean,
): Promise<{
	options: ParsedArgs;
	files: ChangedFile[];
	diffs: Map<string, string>;
	contents:
		| Map<string, { content: string; lineCount: number; truncated: boolean }>
		| undefined;
	projectIndex: import("./git-diff.js").ProjectIndexEntry[] | undefined;
	config: Awaited<ReturnType<typeof loadConfig>>;
	activeConstraints: string;
	scopeMode: string;
	scopeLabel: string;
} | null> {
	let options =
		typeof argsOrOptions === "string"
			? parseArgs(argsOrOptions)
			: argsOrOptions;

	// Apply smart default scope when no explicit review target is given.
	const hasExplicitReviewTarget = Boolean(
		options.files.length > 0 ||
			options.staged ||
			options.all ||
			options.pr ||
			options.explicitRef,
	);
	if (!hasExplicitReviewTarget) {
		const smart = await resolveSmartDefault(pi);
		options = { ...options, ref: smart.ref };
		ctx.ui.notify(`Reviewing ${smart.label}`, "info");
	}

	await ensureDefaultPrompts(ctx.cwd);
	const { config, warnings } = await loadEffectiveConfig(ctx.cwd);
	for (const warning of warnings) {
		console.warn(`${LOG_PREFIX} ${warning}`);
	}
	const activeConstraints = buildActiveConstraints(config.riskTargeting);
	const rawPr = options.pr as (PrInfo & { _raw: string }) | undefined;
	const contextMode = options.all ? "full" : (config.contextMode ?? "full");

	const scope = await resolveReviewScope(
		pi,
		ctx.cwd,
		{
			...options,
			pr: rawPr?._raw,
		},
		{
			contextMode,
			needsProjectIndex,
			ignorePatterns: config.ignorePatterns,
		},
	);
	const {
		files,
		diffs,
		contents,
		projectIndex,
		mode: scopeMode,
		label: scopeLabel,
	} = scope;

	if (files.length === 0) {
		const msg = options.all
			? "No source files found. Ensure your project has files in src/, lib/, app/, or packages/."
			: "No changed files found. Specify file paths, use --all, pass a PR reference, or make some changes first.";
		ctx.ui.notify(msg, "info");
		return null;
	}

	if (!options.all && files.length > MAX_FILES) {
		ctx.ui.notify(
			`Too many changed files (${files.length}). DRYKISS reviews max ${MAX_FILES} files at a time. Run with specific files to review others.`,
			"warning",
		);
		return null;
	}

	return {
		options,
		files,
		diffs,
		contents,
		projectIndex,
		config,
		activeConstraints,
		scopeMode,
		scopeLabel,
	};
}

async function runLensReview(
	ctx: ExtensionContext,
	cwd: string,
	files: ChangedFile[],
	diffs: Map<string, string>,
	lens: ReviewLens,
	options: {
		modelHint?: string;
		contents?: Map<
			string,
			{ content: string; lineCount: number; truncated: boolean }
		>;
		projectIndex?: import("./git-diff.js").ProjectIndexEntry[];
		commands?: { test?: string; lint?: string };
	} = {},
): Promise<{
	lens: ReviewLens;
	findings: Finding[];
	rawOutput: string;
	modelName: string;
}> {
	const prompts = await buildReviewPrompts(cwd, files, diffs, lens, {
		contents: options.contents,
		projectIndex: options.projectIndex,
		commands: options.commands,
	});
	const prompt = prompts[0];
	if (!prompt) return { lens, findings: [], rawOutput: "", modelName: "none" };

	// Use subagent runner for visible Pi subagent spawning
	const { resolveModel, runLensSubagent } = await import(
		"./subagent-runner.js"
	);
	const available = ctx.modelRegistry.getAvailable();
	const model = options.modelHint
		? (findModelByHint(available, options.modelHint) ??
			(await resolveModel(ctx, lens)))
		: await resolveModel(ctx, lens);

	ctx.ui.notify(
		`${LOG_PREFIX} Launching ${lens} subagent with ${model.name}...`,
		"info",
	);

	const result = await runLensSubagent(
		ctx,
		cwd,
		model,
		prompt.systemPrompt,
		prompt.userPrompt,
		lens,
	);

	const rawOutput = result.errorMessage
		? `ERROR: ${result.errorMessage}`
		: result.text || "[]";
	const { findings, parseError } = parseFindingsJson(rawOutput, lens);
	if (parseError && !result.errorMessage) {
		ctx.ui.notify(
			`${LOG_PREFIX} ${lens} lens output could not be parsed. Check console for raw output.`,
			"warning",
		);
	}
	return { lens, findings, rawOutput, modelName: result.modelName };
}

async function prepareReviewOrNotify(
	argsOrOptions: string | ParsedArgs,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	needsProjectIndex: boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof prepareReview>>> | null> {
	try {
		return await prepareReview(argsOrOptions, ctx, pi, needsProjectIndex);
	} catch (err) {
		const msg = toErrorMessage(err);
		ctx.ui.notify(`${LOG_PREFIX} Failed to prepare review: ${msg}`, "error");
		return null;
	}
}

function parseArgsOrNotify(
	args: string,
	ctx: ExtensionCommandContext,
): ParsedArgs | null {
	try {
		return parseArgs(args);
	} catch (err) {
		ctx.ui.notify(
			`${LOG_PREFIX} Invalid arguments: ${toErrorMessage(err)}`,
			"error",
		);
		return null;
	}
}

async function startReviewSessionOrNotify(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	try {
		const session = await startReviewSession(pi, ctx);
		if (!session.success) {
			ctx.ui.notify(session.error, "warning");
			return false;
		}
		return true;
	} catch (err) {
		ctx.ui.notify(
			`${LOG_PREFIX} Failed to start review session: ${toErrorMessage(err)}`,
			"error",
		);
		return false;
	}
}

async function cleanupReviewSessionQuietly(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		const result = await returnFromReviewSession(pi, ctx);
		if (!result.success) {
			ctx.ui.notify(
				result.error ?? `${LOG_PREFIX} Failed to clean up review session.`,
				"warning",
			);
		}
	} catch (err) {
		ctx.ui.notify(
			`${LOG_PREFIX} Failed to clean up review session: ${toErrorMessage(err)}`,
			"warning",
		);
	}
}

export async function handleDrykissCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	const parsed = parseArgsOrNotify(args, ctx);
	if (!parsed) return;
	let branchStarted = false;

	if (parsed.branch) {
		if (!(await startReviewSessionOrNotify(pi, ctx))) return;
		branchStarted = true;
	}

	const prepared = await prepareReviewOrNotify(parsed, ctx, pi, true);
	if (!prepared) {
		if (branchStarted) await cleanupReviewSessionQuietly(pi, ctx);
		return;
	}

	const {
		options,
		files,
		diffs,
		contents,
		projectIndex,
		config,
		activeConstraints,
		scopeMode,
		scopeLabel,
	} = prepared;
	const fileList = files.map((f) => f.path).join(", ");

	// Confirmation (respect config)
	if (config.confirmBeforeRun !== false) {
		const contextMode = options.all ? "full" : config.contextMode;
		const contextLabel =
			contextMode === "diff" ? "diff only" : "full file + project index";
		const scopeLabel = options.all ? "full project scan" : "changed files";
		const ok = await ctx.ui.confirm(
			"DRYKISS Review",
			`Review ${files.length} file(s) (${scopeLabel}) with 7 parallel lens reviews + synthesis.\nContext: ${contextLabel}\n\nFiles: ${fileList}\n\nProceed?`,
		);
		if (!ok) {
			if (branchStarted) await cleanupReviewSessionQuietly(pi, ctx);
			ctx.ui.notify("Review cancelled.", "info");
			return;
		}
	}

	try {
		const jobId = await manager.startReview(
			ctx,
			pi,
			ctx.cwd,
			files,
			diffs,
			contents,
			projectIndex,
			{
				...options,
				activeConstraints,
				commands: config.commands,
				mode: scopeMode,
				scopeLabel,
			},
		);
		ctx.ui.notify(
			`DRYKISS review **${jobId}** started in background. Watch the widget above the editor for live progress. Results will appear here when complete.`,
			"info",
		);
		try {
			setReviewInProgress(true);
			applyReviewState(ctx);
		} catch (err) {
			ctx.ui.notify(
				`${LOG_PREFIX} Review started, but failed to update session widget: ${toErrorMessage(err)}`,
				"warning",
			);
		}
	} catch (err) {
		if (branchStarted) await cleanupReviewSessionQuietly(pi, ctx);
		ctx.ui.notify(`DRYKISS review failed: ${toErrorMessage(err)}`, "error");
	}
}

// ── /drykiss-end — Return from isolated review branch ────

export async function handleEndReviewCommand(
	_args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	try {
		const result = await returnFromReviewSession(pi, ctx);
		if (result.success) {
			ctx.ui.notify(
				"DRYKISS review session ended. Returned to original position.",
				"info",
			);
		} else {
			ctx.ui.notify(result.error ?? "Failed to end review session.", "warning");
		}
	} catch (err) {
		ctx.ui.notify(
			`${LOG_PREFIX} Failed to end review session: ${toErrorMessage(err)}`,
			"error",
		);
	}
}

// ── Single-lens command helper ─────────────────────────

async function handleSingleLensCommand(
	lens: ReviewLens,
	label: string,
	needsProjectIndex: boolean,
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	const prepared = await prepareReviewOrNotify(
		args,
		ctx,
		pi,
		needsProjectIndex,
	);
	if (!prepared) return;

	const {
		options,
		files,
		diffs,
		contents,
		projectIndex,
		config,
		activeConstraints,
		scopeMode,
		scopeLabel,
	} = prepared;

	try {
		const jobId = await manager.startReview(
			ctx,
			pi,
			ctx.cwd,
			files,
			diffs,
			contents,
			projectIndex,
			{
				model: options.model,
				lenses: [lens],
				activeConstraints,
				commands: config.commands,
				mode: scopeMode,
				scopeLabel,
			},
		);
		ctx.ui.notify(
			`${label} **${jobId}** started in background. Watch the widget for live progress.`,
			"info",
		);
	} catch (err: any) {
		ctx.ui.notify(`${label} failed: ${err.message}`, "error");
	}
}

export async function handleKissCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	return handleSingleLensCommand(
		"simplicity",
		"KISS review",
		false,
		args,
		ctx,
		pi,
		manager,
	);
}

export async function handleDryCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	return handleSingleLensCommand(
		"deduplication",
		"DRY review",
		true,
		args,
		ctx,
		pi,
		manager,
	);
}

export async function handleResilienceCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	return handleSingleLensCommand(
		"resilience",
		"Resilience review",
		false,
		args,
		ctx,
		pi,
		manager,
	);
}

export async function handleTestsCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	return handleSingleLensCommand(
		"tests",
		"Test coverage review",
		false,
		args,
		ctx,
		pi,
		manager,
	);
}

export async function handleArchCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	return handleSingleLensCommand(
		"architecture",
		"Architecture review",
		true,
		args,
		ctx,
		pi,
		manager,
	);
}

export async function handleSecurityCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	return handleSingleLensCommand(
		"security",
		"Security review",
		false,
		args,
		ctx,
		pi,
		manager,
	);
}

// ── /drykiss-jobs — Browse running/completed reviews ────

export async function handleJobsCommand(
	_args: string,
	ctx: ExtensionCommandContext,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	const jobs = manager.listJobs();
	if (jobs.length === 0) {
		ctx.ui.notify("No DRYKISS reviews in this session.", "info");
		return;
	}

	const options = jobs.map((j) => {
		const running = j.lenses.filter(
			(l) => j.states.get(l)!.status === "running",
		).length;
		const done = j.lenses.filter((l) => {
			const s = j.states.get(l)!;
			return s.status === "done" || s.status === "error";
		}).length;
		const status =
			j.overallStatus === "running"
				? "● running"
				: j.overallStatus === "error"
					? "✗ error"
					: "✓ done";
		const fileCount = j.files.length;
		const dur = j.completedAt
			? `${((j.completedAt - j.startedAt) / 1000).toFixed(1)}s`
			: `${((Date.now() - j.startedAt) / 1000).toFixed(1)}s`;
		return `${j.id} · ${fileCount} file(s) · ${j.lenses.length} lenses (${running} running, ${done} done) · ${dur} · ${status}`;
	});

	const choice = await ctx.ui.select("DRYKISS Reviews", options);
	if (!choice) return;

	const idx = options.indexOf(choice);
	if (idx < 0) return;
	const job = jobs[idx];

	// Show conversation overlay
	const { ConversationViewer } = await import("./conversation-viewer.js");
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => {
			return new ConversationViewer(tui as any, theme, done, job);
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
		},
	);
}

// ── Tool parameter schema ─────────────────────────────────

const LensParam = Type.Union(
	[
		Type.Literal("simplicity"),
		Type.Literal("deduplication"),
		Type.Literal("clarity"),
		Type.Literal("resilience"),
		Type.Literal("architecture"),
		Type.Literal("tests"),
		Type.Literal("security"),
	],
	{
		description: "Which review lens to apply",
	},
);

export const DrykissReviewParams = Type.Object({
	lens: LensParam,
	files: Type.Array(Type.String(), {
		description: "File paths to review (relative to cwd)",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Model hint, e.g. 'haiku', 'sonnet', 'anthropic/claude-sonnet-4-5'",
		}),
	),
});

export const DrykissAutoreviewParams = Type.Object({
	mode: Type.Optional(
		Type.Union([
			Type.Literal("auto"),
			Type.Literal("local"),
			Type.Literal("staged"),
			Type.Literal("branch"),
			Type.Literal("commit"),
			Type.Literal("pr"),
			Type.Literal("full"),
			Type.Literal("files"),
		]),
	),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific file paths to review (relative to cwd)",
		}),
	),
	base: Type.Optional(
		Type.String({
			description: "Base ref for branch reviews, e.g. origin/main",
		}),
	),
	commit: Type.Optional(
		Type.String({ description: "Commit ref for commit reviews" }),
	),
	pr: Type.Optional(
		Type.String({ description: "GitHub PR URL, owner/repo#123, or PR number" }),
	),
	lenses: Type.Optional(
		Type.Union([
			Type.Literal("all"),
			Type.Array(LensParam, { description: "Subset of DRYKISS lenses to run" }),
		]),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model hint, e.g. 'haiku', 'sonnet', 'anthropic/claude-sonnet-4-5'",
		}),
	),
	contextMode: Type.Optional(
		Type.Union([Type.Literal("diff"), Type.Literal("full")]),
	),
	/**
	 * Output format for the tool's text content. The compact format
	 * (default) emits one line per finding in kiss-check style and
	 * is dramatically smaller than the structured format, which
	 * is useful for agents with limited context budgets. The
	 * structured format includes the full markdown report + JSON
	 * dump of all findings, suitable for human review or
	 * post-processing. Either way, the structured `details` payload
	 * is always populated.
	 */
	format: Type.Optional(
		Type.Union([Type.Literal("compact"), Type.Literal("structured")]),
	),
	maxFiles: Type.Optional(
		Type.Number({
			description: "Maximum files to review. Defaults to 20.",
			minimum: 1,
			maximum: 100,
		}),
	),
	/**
	 * Opt-in: run the Bugbot deep-review pipeline (passes → bucket →
	 * vote → validator) for a single lens instead of the standard
	 * flat multi-lens flow. Set to one of the lens names
	 * ('simplicity', 'deduplication', 'clarity', 'resilience',
	 * 'architecture', 'tests', 'security'). Returns the deep-mode
	 * findings directly in the result.
	 */
	deep: Type.Optional(
		Type.Union([
			Type.Literal("simplicity"),
			Type.Literal("deduplication"),
			Type.Literal("clarity"),
			Type.Literal("resilience"),
			Type.Literal("architecture"),
			Type.Literal("tests"),
			Type.Literal("security"),
		]),
	),
	/** Number of parallel adversarial passes in deep mode. Default 5. */
	deepPasses: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	/** Min votes for a `note` finding to survive the low-signal filter. */
	deepMinVotes: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
	/** When false, skip the deep-mode validator pass (candidates surface unvalidated). */
	deepValidate: Type.Optional(Type.Boolean()),
});

export async function executeDrykissAutoreviewTool(
	params: {
		mode?: ReviewMode;
		files?: string[];
		base?: string;
		commit?: string;
		pr?: string;
		lenses?: "all" | Exclude<ReviewLens, "all">[];
		model?: string;
		contextMode?: "diff" | "full";
		maxFiles?: number;
		/**
		 * Opt-in: run the validator stage over the synthesized
		 * findings. The validator is a separate LLM call that tries
		 * to falsify each finding. Default false.
		 */
		validate?: boolean;
		/**
		 * Opt-in: run the Bugbot deep-review pipeline (passes → bucket
		 * → vote → validator) for a single lens instead of the standard
		 * flat multi-lens flow. Skips synthesis and returns the deep
		 * findings directly.
		 */
		deep?: ReviewLens;
		/** Number of parallel adversarial passes in deep mode. Default 5. */
		deepPasses?: number;
		/** Min votes for a `note` finding to survive the low-signal filter. */
		deepMinVotes?: number;
		/** When false, skip the deep-mode validator pass. Default true. */
		deepValidate?: boolean;
		/**
		 * Output format for the tool's text content. See schema doc
		 * above. Default "compact".
		 */
		format?: "compact" | "structured";
	},
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
	signal?: AbortSignal,
	onUpdate?: (result: {
		content: Array<{ type: "text"; text: string }>;
	}) => void,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { result: ReviewResult };
}> {
	await ensureDefaultPrompts(ctx.cwd);
	const { config: effectiveConfig, warnings } = await loadEffectiveConfig(
		ctx.cwd,
	);
	for (const warning of warnings) {
		console.warn(`${LOG_PREFIX} ${warning}`);
	}
	const suppressions = effectiveConfig.suppressions ?? [];
	const contextMode =
		params.contextMode ?? effectiveConfig.contextMode ?? "full";
	const lenses = normalizeAutoreviewLenses(params.lenses);
	const scope = await resolveReviewScope(
		pi,
		ctx.cwd,
		{
			mode: params.mode,
			files: params.files,
			base: params.base,
			commit: params.commit,
			pr: params.pr,
		},
		{
			contextMode,
			needsProjectIndex:
				lenses.includes("deduplication") || lenses.includes("architecture"),
			ignorePatterns: effectiveConfig.ignorePatterns,
		},
	);

	const maxFiles = params.maxFiles ?? MAX_FILES;
	if (scope.files.length === 0) {
		throw new Error("No files found for DRYKISS autoreview.");
	}
	if (scope.files.length > maxFiles) {
		throw new Error(
			`DRYKISS autoreview scope has ${scope.files.length} files, over the maxFiles limit (${maxFiles}). Narrow the scope or raise maxFiles.`,
		);
	}

	// Deep mode: Bugbot-style pipeline for a single lens. Skips the
	// standard multi-lens flow and synthesis entirely; returns the
	// deep findings directly so the agent can act on them.
	if (params.deep) {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Starting DRYKISS deep-${params.deep} review for ${scope.label} (${scope.files.length} file(s))...`,
				},
			],
		});
		return runDeepAutoreview(
			ctx,
			scope,
			{
				deep: params.deep,
				deepPasses: params.deepPasses,
				deepMinVotes: params.deepMinVotes,
				deepValidate: params.deepValidate,
				model: params.model,
				format: params.format,
			},
			onUpdate,
			signal,
		);
	}

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Starting DRYKISS autoreview for ${scope.label} (${scope.files.length} file(s), ${lenses.length} lens(es))...`,
			},
		],
	});

	// Build active risk-targeting constraints for the lens system prompts.
	// Previously dropped on this path, so risk-targeting config was silently
	// ignored by the autoreview tool (the slash-command path already built it).
	const activeConstraints = buildActiveConstraints(
		effectiveConfig.riskTargeting,
	);

	const result = await manager.runReview(
		ctx,
		pi,
		ctx.cwd,
		scope.files,
		scope.diffs,
		scope.contents,
		scope.projectIndex,
		{
			model: params.model,
			lenses,
			target: {
				mode: scope.mode,
				label: scope.label,
				metadata: scope.metadata,
			},
			severityOverrides: effectiveConfig.riskTargeting?.severity,
			suppressions,
			activeConstraints,
			commands: effectiveConfig.commands,
			// CLI --validate flag takes precedence over config.validate.
			// When neither is set, defaults to false (current behavior).
			validate: params.validate ?? effectiveConfig.validate ?? false,
			onProgress: onUpdate
				? (job) =>
						onUpdate({
							content: [{ type: "text", text: formatReviewProgress(job) }],
						})
				: undefined,
		},
		signal,
	);

	// Apply ignore filter (Phase 2)
	const ignorePatterns = effectiveConfig.riskTargeting?.ignore;
	const filtered = ignorePatterns
		? filterIgnored(result.findings, ignorePatterns)
		: undefined;
	const finalFindings = filtered?.findings ?? result.findings;
	const droppedCount = filtered?.dropped ?? 0;
	const finalSummary =
		droppedCount > 0
			? `${result.summary}\n(DRYKISS dropped ${droppedCount} finding(s) matching ignore patterns.)`
			: result.summary;

	const finalResult: ReviewResult =
		droppedCount > 0
			? {
					...result,
					findings: finalFindings,
					summary: finalSummary,
					counts: {
						total: finalFindings.length,
						critical: finalFindings.filter((f) => f.severity === "critical")
							.length,
						high: finalFindings.filter((f) => f.severity === "high").length,
						medium: finalFindings.filter((f) => f.severity === "medium").length,
						low: finalFindings.filter((f) => f.severity === "low").length,
						nit: finalFindings.filter((f) => f.severity === "nit").length,
						suppressed: result.counts.suppressed ?? 0,
						previouslyRejected: result.counts.previouslyRejected ?? 0,
						validatorReal: result.counts.validatorReal ?? 0,
						validatorFalsePositive: result.counts.validatorFalsePositive ?? 0,
						validatorUnverified: result.counts.validatorUnverified ?? 0,
					},
				}
			: result;

	const formatMode = params.format ?? "compact";
	const text =
		formatMode === "compact"
			? formatReviewResultCompact(finalResult, {
					qualityGateThreshold: effectiveConfig.qualityGate,
				})
			: formatReviewResultForTool(finalResult, {
					qualityGateThreshold: effectiveConfig.qualityGate,
				});

	return {
		content: [{ type: "text", text }],
		details: { result: finalResult },
	};
}

function normalizeAutoreviewLenses(
	value: "all" | Exclude<ReviewLens, "all">[] | undefined,
): Exclude<ReviewLens, "all">[] {
	if (!value || value === "all") return [...LENS_NAMES];
	return value.length > 0 ? value : [...LENS_NAMES];
}

function formatReviewProgress(job: ReviewJob): string {
	const done = job.lenses.filter((lens) => {
		const state = job.states.get(lens);
		return state?.status === "done" || state?.status === "error";
	}).length;
	const running = job.lenses.filter(
		(lens) => job.states.get(lens)?.status === "running",
	);
	const errored = job.lenses.filter(
		(lens) => job.states.get(lens)?.status === "error",
	).length;
	const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
	const synthesis =
		job.synthesisStatus === "running"
			? " · synthesis running"
			: job.synthesisStatus === "done"
				? " · synthesis done"
				: job.synthesisStatus === "error"
					? " · synthesis error"
					: "";
	const runningText = running.length ? ` · running: ${running.join(", ")}` : "";
	const errorText = errored ? ` · ${errored} error(s)` : "";
	return `DRYKISS autoreview progress: ${done}/${job.lenses.length} lens(es) complete${runningText}${synthesis}${errorText} · ${elapsed}s`;
}

function formatReviewResultForTool(
	result: ReviewResult,
	options?: { qualityGateThreshold?: number },
): string {
	const threshold = options?.qualityGateThreshold ?? 70;
	const suppressedStr =
		result.counts.suppressed > 0
			? `, ${result.counts.suppressed} suppressed`
			: "";
	// When validation drops findings, the raw synthesis output may
	// still contain them — surface the drop count so the discrepancy
	// between this summary and the persisted report is visible.
	const validationDropped =
		result.findings.length === 0 &&
		result.counts.total === 0 &&
		result.validationIssues.length > 0;
	const validationStr = validationDropped
		? ` (raw synthesis output preserved: ${result.validationIssues.length} finding(s) dropped during validation — see issues below)`
		: "";
	const findingsLine = `findings: ${result.counts.total} (${result.counts.critical} critical, ${result.counts.high} high, ${result.counts.medium} medium, ${result.counts.low} low, ${result.counts.nit} nit${suppressedStr})${validationStr}`;
	const scoreLine = `health score: ${result.healthScore}/100`;
	const breakdown = result.scoreBreakdown;
	const scoreDetail = `(critical: ${breakdown.critical}, warning: ${breakdown.warning}, suggestion: ${breakdown.suggestion})`;
	const trendLine =
		result.prevScore != null
			? `trend: ${result.prevScore} → ${result.healthScore} (${result.healthScore - result.prevScore >= 0 ? "+" : ""}${result.healthScore - result.prevScore})`
			: "";
	const qualityGate =
		result.healthScore < threshold
			? "⛔ quality gate: FAIL"
			: "✅ quality gate: pass";
	const lines = [
		`DRYKISS autoreview ${result.clean ? "clean" : "completed with findings"}`,
		`target: ${result.target?.label ?? "unknown"}`,
		`verdict: ${result.verdict}`,
		findingsLine,
		scoreLine,
		scoreDetail,
	];
	if (trendLine) lines.push(trendLine);
	lines.push(qualityGate);
	if (result.validationIssues.length > 0) {
		lines.push("");
		lines.push(`validation issues (${result.validationIssues.length}):`);
		for (const vi of result.validationIssues.slice(0, 5)) {
			lines.push(`  - finding #${vi.findingIndex}: ${vi.reason}`);
		}
		if (result.validationIssues.length > 5) {
			lines.push(`  ... and ${result.validationIssues.length - 5} more`);
		}
	}
	if (result.mermaidGraph) {
		lines.push("");
		lines.push("=== Dependency Graph ===");
		lines.push(result.mermaidGraph);
	}
	if (result.reportPath) lines.push(`report: ${result.reportPath}`);
	if (result.errors.length > 0)
		lines.push(`errors: ${result.errors.join("; ")}`);
	if (result.validationIssues.length > 0) {
		lines.push(`validation issues: ${result.validationIssues.length}`);
	}
	lines.push("", result.summary);
	if (result.findings.length > 0) {
		lines.push("", JSON.stringify(result.findings, null, 2));
	}
	return lines.join("\n");
}

export async function executeDrykissReviewTool(
	params: {
		lens:
			| "simplicity"
			| "deduplication"
			| "clarity"
			| "resilience"
			| "architecture"
			| "tests"
			| "security";
		files: string[];
		model?: string;
	},
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { findings: Finding[] };
}> {
	await ensureDefaultPrompts(ctx.cwd);
	const { config, warnings } = await loadEffectiveConfig(ctx.cwd);
	for (const warning of warnings) {
		console.warn(`${LOG_PREFIX} ${warning}`);
	}
	const contextMode = config.contextMode ?? "full";
	const needsProjectIndex =
		params.lens === "deduplication" || params.lens === "architecture";

	const scope = await resolveReviewScope(
		pi,
		ctx.cwd,
		{ mode: "files", files: params.files },
		{
			contextMode,
			needsProjectIndex,
			ignorePatterns: config.ignorePatterns,
		},
	);
	const { files: filesToReview, diffs, contents, projectIndex } = scope;

	const review = await runLensReview(
		ctx,
		ctx.cwd,
		filesToReview,
		diffs,
		params.lens,
		{
			modelHint: params.model,
			contents,
			projectIndex,
			commands: config.commands,
		},
	);

	return {
		content: [{ type: "text", text: JSON.stringify(review.findings, null, 2) }],
		details: { findings: review.findings },
	};
}

/**
 * Run the Bugbot deep-review pipeline for a single lens and return
 * the result in the same `ReviewResult` shape the flat multi-lens
 * flow produces, so the agent doesn't need to special-case the
 * return value.
 *
 * Mapping from `DeepValidatedFinding` (blocker|warning|note) to
 * `Finding` (critical|high|medium|low|nit):
 *   - blocker   → critical
 *   - warning   → high
 *   - note (validated, votes ≥ 2) → medium
 *   - note (validated, votes 1)  → low
 *
 * This is a deliberate 3→2-step ladder: the deep pipeline's three
 * severity tiers get promoted to DRYKISS's five-tier scale so the
 * downstream counts/verdict/health-score logic is unchanged.
 */
async function runDeepAutoreview(
	ctx: ExtensionContext,
	scope: ReviewScope,
	params: {
		deep: ReviewLens;
		deepPasses?: number;
		deepMinVotes?: number;
		deepValidate?: boolean;
		model?: string;
		format?: "compact" | "structured";
	},
	onUpdate:
		| ((result: { content: Array<{ type: "text"; text: string }> }) => void)
		| undefined,
	signal: AbortSignal | undefined,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { result: ReviewResult };
}> {
	// Lazy-import the deep-review module so the autoreview tool's
	// startup cost doesn't pull it in for flat-mode runs.
	const {
		runDeepReview,
		buildModelPlan,
		loadDeepPassSystemPrompt,
		makePiCallerAdapter,
	} = await import("./deep-review.js");
	const { findModelByHint } = await import("./model-utils.js");

	const available = ctx.modelRegistry.getAvailable();
	const sessionModel = findModelByHint(available, params.model ?? "haiku");
	if (!sessionModel) {
		throw new Error("No model available for deep-review pipeline.");
	}

	// Build the lens system prompt: reuse the existing lens
	// composition so the deep-mode pass sees the same per-lens body
	// (criteria, project-specific overlays, etc.) the flat-mode
	// lens would see.
	const { composeLensPrompt } = await import("./prompt-composer.js");
	// Narrow the deep field to a non-"all" lens for the inner pipeline.
	if (params.deep === "all") {
		throw new Error(
			"Deep mode requires a specific lens name (e.g. 'security'), not 'all'.",
		);
	}
	const lensSystem = await composeLensPrompt(params.deep as never, {});

	// Build the user prompt: scope label + the diff blocks. Reuse
	// the existing context builder for consistency with the flat
	// flow.
	const diffBlock = formatDiffsForDeepAutoreview(scope);

	const baseUserPrompt = `# Deep Review (${params.deep} lens)\n\n${diffBlock}`;

	const passSystem = await loadDeepPassSystemPrompt();
	const validatorSystem = await readValidatorSystemPrompt();

	const config: import("./deep-review.js").DeepReviewConfig = {
		passes: params.deepPasses ?? 5,
		concurrency: params.deepPasses ?? 5,
		temperature: 0.4,
		maxFindings: 50,
		minVotes: params.deepMinVotes ?? 2,
		...(signal ? { signal } : {}),
	};

	const plan = buildModelPlan({
		passModelKey: sessionModel.id,
		passModelLabel: sessionModel.name,
		validatorModelKey: sessionModel.id,
		validatorModelLabel: sessionModel.name,
		passes: config.passes,
	});

	const caller = makePiCallerAdapter(ctx, sessionModel);

	const onStage = (stage: string) => {
		onUpdate?.({
			content: [{ type: "text", text: `Deep review: ${stage}...` }],
		});
	};

	const result = await runDeepReview({
		baseUserPrompt,
		config,
		plan,
		passSystem: lensSystem + "\n\n" + passSystem,
		validatorSystem,
		caller,
		hooks: { onStage },
	});

	// Map DeepSeverity → Severity.
	const mapSeverity = (
		deep: import("./deep-review.js").DeepSeverity,
		votes: number,
	): Severity => {
		if (deep === "blocker") return "critical";
		if (deep === "warning") return "high";
		return votes >= 2 ? "medium" : "low";
	};

	const findings: Finding[] = result.findings.map((f) => ({
		file: f.file,
		...(f.line !== undefined ? { line: f.line } : {}),
		severity: mapSeverity(f.severity, f.votes),
		category: f.category ?? "Deep Review Finding",
		summary: f.message,
		detail: f.message,
		suggestion: "",
		consequence: undefined,
		source: params.deep as string,
		fixability: undefined,
		confidence: f.votes >= 2 ? "confirmed" : "likely",
		lens: params.deep as never,
		riskCode: undefined,
		action: "fix",
		riskLevel: f.severity === "blocker" ? "high" : "medium",
		priority: undefined,
		_validatorVerdict: f.verdict === "real" ? "real" : "unverified",
		_validatorJustification: f.justification,
	}));

	const critical = findings.filter((f) => f.severity === "critical").length;
	const high = findings.filter((f) => f.severity === "high").length;
	const medium = findings.filter((f) => f.severity === "medium").length;
	const low = findings.filter((f) => f.severity === "low").length;
	const nit = findings.filter((f) => f.severity === "nit").length;
	const scoreBreakdown = {
		critical,
		warning: high + medium,
		suggestion: low + nit,
	};
	const healthScore = Math.max(
		0,
		100 -
			scoreBreakdown.critical * 15 -
			scoreBreakdown.warning * 5 -
			scoreBreakdown.suggestion * 1,
	);
	const verdict: "Approve" | "Request changes" | "Needs security review" =
		critical > 0 ? "Request changes" : high > 0 ? "Request changes" : "Approve";

	const reviewResult: ReviewResult = {
		jobId: "deep",
		clean: verdict === "Approve" && findings.length === 0,
		status: "done",
		verdict,
		files: scope.files.map((f) => f.path),
		counts: {
			total: findings.length,
			critical,
			high,
			medium,
			low,
			nit,
			suppressed: 0,
			previouslyRejected: 0,
			validatorReal: result.findings.length,
			validatorFalsePositive: result.rejected.length,
			validatorUnverified: 0,
		},
		findings,
		summary: `Deep review (${params.deep}) found ${findings.length} finding(s) across ${result.telemetry.passes} adversarial passes.`,
		errors: [],
		validationIssues: [],
		healthScore,
		scoreBreakdown,
	};

	const formatMode = params.format ?? "compact";
	const text =
		formatMode === "compact"
			? formatReviewResultCompact(reviewResult, { qualityGateThreshold: 70 })
			: formatReviewResultForTool(reviewResult, { qualityGateThreshold: 70 });

	return {
		content: [{ type: "text", text }],
		details: { result: reviewResult },
	};
}

/** Format the resolved scope's diffs for the deep-mode pass prompt. */
function formatDiffsForDeepAutoreview(scope: ReviewScope): string {
	if (scope.diffs.size === 0) return "(no diff)";
	const blocks: string[] = [];
	const PER_FILE_BUDGET = 8_000;
	for (const [file, diff] of scope.diffs) {
		const truncated =
			diff.length > PER_FILE_BUDGET
				? `${diff.slice(0, PER_FILE_BUDGET)}\n... (truncated)`
				: diff;
		blocks.push(`### ${file}\n\n${truncated}`);
	}
	return `# Diff Under Review\n\n${blocks.join("\n\n")}`;
}

/** Load the deep-mode validator system prompt. */
async function readValidatorSystemPrompt(): Promise<string> {
	const { bundledPromptsDir } = await import("./prompt-loader.js");
	const { readFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const path = join(bundledPromptsDir(), "_shared", "validator-bugbot.md");
	return readFile(path, "utf8");
}
