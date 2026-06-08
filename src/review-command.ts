import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	getChangedFiles,
	getFileDiff,
	getFileContent,
	getProjectIndex,
} from "./git-diff.js";
import { buildReviewPrompts, ensureDefaultPrompts } from "./prompt-builder.js";

import { loadConfig, loadEffectiveConfig } from "./config.js";
import { buildActiveConstraints } from "./active-constraints.js";
import { findModelByHint } from "./llm.js";
import type {
	ReviewLens,
	ReviewOptions,
	ChangedFile,
	Finding,
} from "./types.js";
import { LENS_NAMES, parseFindingsArray } from "./types.js";
import { lenientJsonParse, sanitizeJsonString } from "./json-utils.js";
import { isPrReference, type PrInfo } from "./github-pr.js";
import { resolveReviewScope, type ReviewMode } from "./review-scope.js";
import type { ReviewJob } from "./review-manager.js";
import type { ReviewResult } from "./review-result.js";
import { filterIgnored } from "./review-result.js";
import { LOG_PREFIX } from "./constants.js";

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
}

export function parseArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const files: string[] = [];
	let ref = "HEAD";
	let staged = false;
	let all = false;
	let model: string | undefined;
	let pr: PrInfo | undefined;

	for (const token of tokens) {
		if (token === "--staged") {
			staged = true;
		} else if (token === "--all") {
			all = true;
		} else if (token.startsWith("--ref=")) {
			ref = token.slice("--ref=".length);
		} else if (token.startsWith("--model=")) {
			model = token.slice("--model=".length);
		} else if (isPrReference(token)) {
			// Will be resolved in prepareReview after we get the git remote
			pr = { owner: "", repo: "", number: 0, _raw: token } as PrInfo & {
				_raw: string;
			};
		} else {
			files.push(token);
		}
	}

	return { files, ref, staged, all, model, pr };
}

async function gatherDiffs(
	pi: ExtensionAPI,
	cwd: string,
	files: ChangedFile[],
	options: ReviewOptions,
): Promise<{ diffs: Map<string, string>; failedFiles: string[] }> {
	const diffs = new Map<string, string>();
	const failedFiles: string[] = [];
	for (const file of files) {
		try {
			const diff = await getFileDiff(pi, cwd, file.path, options);
			diffs.set(file.path, diff);
		} catch {
			diffs.set(file.path, "(diff unavailable)");
			failedFiles.push(file.path);
		}
	}
	return { diffs, failedFiles };
}

async function gatherContents(
	cwd: string,
	files: ChangedFile[],
): Promise<
	Map<string, { content: string; lineCount: number; truncated: boolean }>
> {
	const contents = new Map<
		string,
		{ content: string; lineCount: number; truncated: boolean }
	>();
	for (const file of files) {
		try {
			const result = await getFileContent(cwd, file.path);
			if (result) contents.set(file.path, result);
		} catch (e) {
			// Skip unreadable files — warn so users know content was omitted
			console.warn(`${LOG_PREFIX} Skipping unreadable file ${file.path}: ${(e as Error).message}`);
		}
	}
	return contents;
}

/**
 * Common review setup: parses args, gathers files, diffs, contents, and project index.
 * Shared between handleDrykissCommand and handleSingleLensCommand.
 */
async function prepareReview(
	args: string,
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
} | null> {
	const options = parseArgs(args);
	await ensureDefaultPrompts(ctx.cwd);
	const config = await loadConfig();
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
		{ contextMode, needsProjectIndex },
	);
	const { files, diffs, contents, projectIndex } = scope;

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
	};
}

export interface ParseFindingsResult {
	findings: Finding[];
	parseError?: string;
}

function parseFindingsJson(raw: string, lens: ReviewLens): ParseFindingsResult {
	// First, try to extract JSON array from the output
	// Use non-greedy match: lens findings never contain nested arrays,
	// and greedy match would capture trailing Mermaid graph syntax (e.g. A[a.ts]).
	const jsonMatch = raw.match(/\[[\s\S]*?\]/);
	const jsonStr = jsonMatch ? jsonMatch[0] : raw;

	// Try parsing as-is first
	try {
		const parsed = JSON.parse(jsonStr);
		if (!Array.isArray(parsed)) {
			return {
				findings: [],
				parseError: `Expected array, got ${typeof parsed}`,
			};
		}
		return {
			findings: parseFindingsArray(parsed, lens),
		};
	} catch {
		// If initial parse fails, try sanitizing the JSON
		try {
			const sanitized = sanitizeJsonString(jsonStr);
			const parsed = JSON.parse(sanitized);
			if (Array.isArray(parsed)) {
				return {
					findings: parseFindingsArray(parsed, lens),
				};
			}
		} catch (sanitizationErr) {
			// Sanitization didn't help, fall through to error
		}

		// Both attempts failed — try lenient parse as last resort before giving up
		try {
			const lenient = lenientJsonParse<unknown[]>(jsonStr);
			if (Array.isArray(lenient)) {
				return {
					findings: parseFindingsArray(lenient, lens),
				};
			}
		} catch {
			/* lenient parse also failed — fall through to error */
		}

		const msg = `Failed to parse JSON for ${lens} lens. The LLM output may contain unescaped characters.`;
		return { findings: [], parseError: msg };
	}
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

export async function handleDrykissCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	manager: import("./review-manager.js").ReviewManager,
): Promise<void> {
	let prepared: Awaited<ReturnType<typeof prepareReview>> = null;
	try {
		prepared = await prepareReview(args, ctx, pi, true);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`${LOG_PREFIX} Failed to prepare review: ${msg}`, "error");
		return;
	}
	if (!prepared) return;

	const {
		options,
		files,
		diffs,
		contents,
		projectIndex,
		config,
		activeConstraints,
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
			{ ...options, activeConstraints },
		);
		ctx.ui.notify(
			`DRYKISS review **${jobId}** started in background. Watch the widget above the editor for live progress. Results will appear here when complete.`,
			"info",
		);
	} catch (err: any) {
		ctx.ui.notify(`DRYKISS review failed: ${err.message}`, "error");
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
	let prepared: Awaited<ReturnType<typeof prepareReview>> = null;
	try {
		prepared = await prepareReview(args, ctx, pi, needsProjectIndex);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`${LOG_PREFIX} Failed to prepare review: ${msg}`, "error");
		return;
	}
	if (!prepared) return;

	const { options, files, diffs, contents, projectIndex, activeConstraints } =
		prepared;

	try {
		const jobId = await manager.startReview(
			ctx,
			pi,
			ctx.cwd,
			files,
			diffs,
			contents,
			projectIndex,
			{ model: options.model, lenses: [lens], activeConstraints },
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
	maxFiles: Type.Optional(
		Type.Number({
			description: "Maximum files to review. Defaults to 20.",
			minimum: 1,
			maximum: 100,
		}),
	),
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
	const config = await loadConfig();
	const { config: effectiveConfig } = await loadEffectiveConfig(ctx.cwd);
	const suppressions = effectiveConfig.suppressions ?? [];
	const contextMode = params.contextMode ?? config.contextMode ?? "full";
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

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Starting DRYKISS autoreview for ${scope.label} (${scope.files.length} file(s), ${lenses.length} lens(es))...`,
			},
		],
	});

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
			severityOverrides: config.riskTargeting?.severity,
			suppressions,
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
	const ignorePatterns = config.riskTargeting?.ignore;
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
					},
				}
			: result;

	return {
		content: [{ type: "text", text: formatReviewResultForTool(finalResult) }],
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

function formatReviewResultForTool(result: ReviewResult): string {
	const suppressedStr =
		result.counts.suppressed > 0
			? `, ${result.counts.suppressed} suppressed`
			: "";
	const findingsLine = `findings: ${result.counts.total} (${result.counts.critical} critical, ${result.counts.high} high, ${result.counts.medium} medium, ${result.counts.low} low, ${result.counts.nit} nit${suppressedStr})`;
	const scoreLine = `health score: ${result.healthScore}/100`;
	const breakdown = result.scoreBreakdown;
	const scoreDetail = `(critical: ${breakdown.critical}, warning: ${breakdown.warning}, suggestion: ${breakdown.suggestion})`;
	const trendLine =
		result.prevScore != null
			? `trend: ${result.prevScore} → ${result.healthScore} (${result.healthScore - result.prevScore >= 0 ? "+" : ""}${result.healthScore - result.prevScore})`
			: "";
	const qualityGate =
		result.healthScore < 70 ? "⛔ quality gate: FAIL" : "✅ quality gate: pass";
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
	const options: ReviewOptions = {
		files: params.files,
		ref: "HEAD",
		staged: false,
		all: false,
	};

	const changedFiles = await getChangedFiles(pi, ctx.cwd, options);
	const filesToReview =
		changedFiles.length > 0
			? changedFiles
			: params.files.map((p) => ({
					path: p,
					status: "modified" as const,
					language: null,
				}));

	await ensureDefaultPrompts(ctx.cwd);
	const { diffs, failedFiles } = await gatherDiffs(
		pi,
		ctx.cwd,
		filesToReview,
		options,
	);
	if (failedFiles.length > 0) {
		/* Diffs unavailable — continuing with placeholders */
	}
	const config = await loadConfig();
	const contents =
		config.contextMode !== "diff"
			? await gatherContents(ctx.cwd, filesToReview)
			: undefined;
	const projectIndex =
		config.contextMode !== "diff" &&
		(params.lens === "deduplication" || params.lens === "architecture")
			? await getProjectIndex(ctx.cwd)
			: undefined;

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
		},
	);

	return {
		content: [{ type: "text", text: JSON.stringify(review.findings, null, 2) }],
		details: { findings: review.findings },
	};
}
