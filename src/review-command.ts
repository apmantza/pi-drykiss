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

import { loadConfig } from "./config.js";
import { findModelByHint } from "./llm.js";
import type {
	ReviewLens,
	ReviewOptions,
	ChangedFile,
	Finding,
} from "./types.js";
import { parseFindingsArray } from "./types.js";
import { lenientJsonParse, sanitizeJsonString } from "./json-utils.js";
import {
	isPrReference,
	isGhAvailable,
	getGitRemote,
	fetchPrDiff,
	fetchPrFileContents,
	parsePrUrl,
	type PrInfo,
} from "./github-pr.js";

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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[DRYKISS] Failed to get diff for ${file.path}:`, msg);
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
		const result = await getFileContent(cwd, file.path);
		if (result) contents.set(file.path, result);
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
} | null> {
	const options = parseArgs(args);

	// Check if this is a PR review
	const rawPr = options.pr as (PrInfo & { _raw: string }) | undefined;
	if (rawPr?._raw) {
		return preparePrReview(rawPr._raw, ctx, pi, needsProjectIndex);
	}

	const files = await getChangedFiles(pi, ctx.cwd, options);

	if (files.length === 0) {
		const msg = options.all
			? "No source files found. Ensure your project has files in src/, lib/, app/, or packages/."
			: "No changed files found. Specify file paths, use --all, or make some changes first.";
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

	await ensureDefaultPrompts(ctx.cwd);
	const config = await loadConfig();

	// --all implies full context (diffs are empty for unchanged files)
	const contextMode = options.all ? "full" : config.contextMode;

	const { diffs, failedFiles } = await gatherDiffs(pi, ctx.cwd, files, options);
	if (failedFiles.length > 0) {
		ctx.ui.notify(
			`[DRYKISS] Could not retrieve diffs for: ${failedFiles.join(", ")}. Review will use available diffs.`,
			"warning",
		);
	}
	const contents =
		contextMode !== "diff" ? await gatherContents(ctx.cwd, files) : undefined;
	const projectIndex =
		needsProjectIndex && contextMode !== "diff"
			? await getProjectIndex(ctx.cwd)
			: undefined;

	return { options, files, diffs, contents, projectIndex, config };
}

/**
 * Prepare a review for a GitHub PR.
 */
async function preparePrReview(
	prInput: string,
	ctx: ExtensionCommandContext,
	_pi: ExtensionAPI,
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
} | null> {
	// Check if gh CLI is available
	if (!(await isGhAvailable())) {
		ctx.ui.notify(
			"GitHub CLI (gh) is required for PR reviews. Install it from https://cli.github.com/",
			"error",
		);
		return null;
	}

	// Resolve PR URL using git remote if needed
	let prInfo = parsePrUrl(prInput);
	if (!prInfo || !prInfo.owner) {
		const remote = await getGitRemote(ctx.cwd);
		if (remote) {
			prInfo = parsePrUrl(prInput, remote);
		}
	}

	if (!prInfo || !prInfo.owner) {
		ctx.ui.notify(
			"Could not parse PR reference. Use: /drykiss https://github.com/owner/repo/pull/123 or /drykiss owner/repo#123",
			"error",
		);
		return null;
	}

	// Fetch PR diff
	ctx.ui.notify(
		`[DRYKISS] Fetching PR #${prInfo.number} from ${prInfo.owner}/${prInfo.repo}...`,
		"info",
	);

	let prDiff;
	try {
		prDiff = await fetchPrDiff(
			ctx.cwd,
			prInfo.owner,
			prInfo.repo,
			prInfo.number,
		);
	} catch (err: any) {
		ctx.ui.notify(`Failed to fetch PR: ${err.message}`, "error");
		return null;
	}

	if (prDiff.files.length === 0) {
		ctx.ui.notify("PR has no changed files.", "info");
		return null;
	}

	if (prDiff.files.length > MAX_FILES) {
		ctx.ui.notify(
			`PR has ${prDiff.files.length} changed files. DRYKISS reviews max ${MAX_FILES} files at a time.`,
			"warning",
		);
		return null;
	}

	await ensureDefaultPrompts(ctx.cwd);
	const config = await loadConfig();

	// Fetch full file contents for context (PR reviews always use full context)
	ctx.ui.notify(
		`[DRYKISS] Fetching full file contents for ${prDiff.files.length} files...`,
		"info",
	);

	const filePaths = prDiff.files.map((f) => f.path);
	const contents = await fetchPrFileContents(
		ctx.cwd,
		prInfo.owner,
		prInfo.repo,
		prDiff.headSha,
		filePaths,
	);

	const projectIndex = needsProjectIndex
		? await getProjectIndex(ctx.cwd)
		: undefined;

	return {
		options: { files: [], ref: "HEAD", staged: false, all: false },
		files: prDiff.files,
		diffs: prDiff.diffs,
		contents,
		projectIndex,
		config,
	};
}

export interface ParseFindingsResult {
	findings: Finding[];
	parseError?: string;
}

function parseFindingsJson(raw: string, lens: ReviewLens): ParseFindingsResult {
	// First, try to extract JSON array from the output
	const jsonMatch = raw.match(/\[[\s\S]*\]/);
	const jsonStr = jsonMatch ? jsonMatch[0] : raw;

	// Try parsing as-is first
	try {
		const parsed = JSON.parse(jsonStr);
		if (!Array.isArray(parsed)) {
			console.warn(
				`[DRYKISS] ${lens} lens returned non-array JSON:`,
				raw.slice(0, 500),
			);
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
			console.error(
				`[DRYKISS] JSON sanitization failed for ${lens}:`,
				sanitizationErr instanceof Error
					? sanitizationErr.message
					: String(sanitizationErr),
			);
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

		const msg = `Failed to parse JSON. The LLM output may contain unescaped characters.`;
		console.error(`[DRYKISS] Failed to parse JSON for ${lens} lens.`);
		console.error(
			`[DRYKISS] Raw output (first 1200 chars):`,
			raw.slice(0, 1200),
		);
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
		`[DRYKISS] Launching ${lens} subagent with ${model.name}...`,
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
			`[DRYKISS] ${lens} lens output could not be parsed. Check console for raw output.`,
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
		ctx.ui.notify(`[DRYKISS] Failed to prepare review: ${msg}`, "error");
		return;
	}
	if (!prepared) return;

	const { options, files, diffs, contents, projectIndex, config } = prepared;
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
			options,
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
		ctx.ui.notify(`[DRYKISS] Failed to prepare review: ${msg}`, "error");
		return;
	}
	if (!prepared) return;

	const { options, files, diffs, contents, projectIndex } = prepared;

	try {
		const jobId = await manager.startReview(
			ctx,
			pi,
			ctx.cwd,
			files,
			diffs,
			contents,
			projectIndex,
			{ model: options.model, lenses: [lens] },
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
			return new ConversationViewer(tui, theme, done, job);
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
		},
	);
}

// ── Tool parameter schema ─────────────────────────────────

export const DrykissReviewParams = Type.Object({
	lens: Type.Union(
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
	),
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
		console.warn(
			`[DRYKISS] Could not retrieve diffs for: ${failedFiles.join(", ")}`,
		);
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
