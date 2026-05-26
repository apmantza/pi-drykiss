import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	getChangedFiles,
	getFileDiff,
	getFileContent,
	getProjectIndex,
} from "./git-diff.js";
import {
	buildReviewPrompts,
	buildSynthesisPrompt,
	ensureDefaultPrompts,
} from "./prompt-builder.js";
import { callLLM } from "./llm.js";
import { saveReview, formatReviewForDisplay } from "./persist.js";
import { loadConfig } from "./config.js";
import type {
	ReviewLens,
	ReviewOptions,
	ChangedFile,
	Finding,
	SynthesisResult,
	Severity,
} from "./types.js";

export const COMMAND_NAME = "drykiss";
export const KISS_COMMAND_NAME = "drykiss-kiss";
export const DRY_COMMAND_NAME = "drykiss-dry";
export const RESILIENCE_COMMAND_NAME = "drykiss-resilience";
export const ARCH_COMMAND_NAME = "drykiss-arch";
export const TESTS_COMMAND_NAME = "drykiss-tests";

const MAX_FILES = 20;

export interface ParsedArgs extends ReviewOptions {
	readonly model?: string;
}

export function parseArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const files: string[] = [];
	let ref = "HEAD";
	let staged = false;
	let all = false;
	let model: string | undefined;

	for (const token of tokens) {
		if (token === "--staged") {
			staged = true;
		} else if (token === "--all") {
			all = true;
		} else if (token.startsWith("--ref=")) {
			ref = token.slice("--ref=".length);
		} else if (token.startsWith("--model=")) {
			model = token.slice("--model=".length);
		} else {
			files.push(token);
		}
	}

	return { files, ref, staged, all, model };
}

async function gatherDiffs(
	pi: ExtensionAPI,
	cwd: string,
	files: ChangedFile[],
	options: ReviewOptions,
): Promise<Map<string, string>> {
	const diffs = new Map<string, string>();
	for (const file of files) {
		try {
			const diff = await getFileDiff(pi, cwd, file.path, options);
			diffs.set(file.path, diff);
		} catch {
			diffs.set(file.path, "(diff unavailable)");
		}
	}
	return diffs;
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

function parseFindingsJson(raw: string, lens: ReviewLens): Finding[] {
	try {
		const jsonMatch = raw.match(/\[[\s\S]*\]/);
		const jsonStr = jsonMatch ? jsonMatch[0] : raw;
		const parsed = JSON.parse(jsonStr);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((f: any) => ({
			file: String(f.file ?? "unknown"),
			line: typeof f.line === "number" ? f.line : undefined,
			severity: String(f.severity ?? "medium") as Severity,
			category: String(f.category ?? ""),
			summary: String(f.summary ?? ""),
			detail: String(f.detail ?? f.summary ?? ""),
			suggestion: String(f.suggestion ?? ""),
			lens,
		}));
	} catch {
		return [];
	}
}

function parseSynthesisJson(raw: string): SynthesisResult | null {
	try {
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		const jsonStr = jsonMatch ? jsonMatch[0] : raw;
		const parsed = JSON.parse(jsonStr);
		if (typeof parsed !== "object" || parsed === null) return null;

		const findings = Array.isArray(parsed.findings)
			? (parsed.findings as any[]).map((f: any) => ({
					file: String(f.file ?? "unknown"),
					line: typeof f.line === "number" ? f.line : undefined,
					severity: String(f.severity ?? "medium") as Severity,
					category: String(f.category ?? ""),
					summary: String(f.summary ?? ""),
					detail: String(f.detail ?? f.summary ?? ""),
					suggestion: String(f.suggestion ?? ""),
					confidence: String(f.confidence ?? "likely") as
						| "confirmed"
						| "likely"
						| "suspect",
				}))
			: [];

		return {
			findings,
			summary: String(parsed.summary ?? ""),
			verdict: String(
				parsed.verdict ?? "Request changes",
			) as SynthesisResult["verdict"],
			criticalCount: findings.filter((f) => f.severity === "critical").length,
			highCount: findings.filter((f) => f.severity === "high").length,
			mediumCount: findings.filter((f) => f.severity === "medium").length,
			lowCount: findings.filter((f) => f.severity === "low").length,
			nitCount: findings.filter((f) => f.severity === "nit").length,
		};
	} catch {
		return null;
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

	ctx.ui.notify(`[DRYKISS] Running ${lens} review...`, "info");

	const { text: rawOutput, model } = await callLLM(
		ctx,
		cwd,
		prompt.systemPrompt,
		prompt.userPrompt,
		{ temperature: 0.2, maxTokens: 4000, signal: ctx.signal },
		options.modelHint ? undefined : lens,
	);

	const findings = parseFindingsJson(rawOutput, lens);
	return { lens, findings, rawOutput, modelName: model.name };
}

async function runSynthesis(
	ctx: ExtensionContext,
	cwd: string,
	lensReviews: Array<{ lens: ReviewLens; rawOutput: string }>,
	modelHint?: string,
): Promise<SynthesisResult> {
	const { systemPrompt, userPrompt } = await buildSynthesisPrompt(
		cwd,
		lensReviews,
	);

	ctx.ui.notify(`[DRYKISS] Synthesizing findings...`, "info");

	const { text: rawOutput } = await callLLM(
		ctx,
		cwd,
		systemPrompt,
		userPrompt,
		{ temperature: 0.2, maxTokens: 4000, signal: ctx.signal },
		modelHint ? undefined : "synthesis",
	);

	const result = parseSynthesisJson(rawOutput);
	if (result) return result;

	return {
		findings: [],
		summary:
			"Synthesis returned non-JSON output. Raw response available in logs.",
		verdict: "Request changes",
		criticalCount: 0,
		highCount: 0,
		mediumCount: 0,
		lowCount: 0,
		nitCount: 0,
	};
}

export async function handleDrykissCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const options = parseArgs(args);
	const files = await getChangedFiles(pi, ctx.cwd, options);

	if (files.length === 0) {
		const msg = options.all
			? "No source files found. Ensure your project has files in src/, lib/, app/, or packages/."
			: "No changed files found. Specify file paths, use --all, or make some changes first.";
		ctx.ui.notify(msg, "info");
		return;
	}

	if (!options.all && files.length > MAX_FILES) {
		ctx.ui.notify(
			`Too many changed files (${files.length}). DRYKISS reviews max ${MAX_FILES} files at a time. Run with specific files to review others.`,
			"warning",
		);
		return;
	}

	const config = await loadConfig(ctx.cwd);

	// --all implies full context (diffs are empty for unchanged files)
	const contextMode = options.all ? "full" : config.contextMode;

	// Ensure default prompts exist on disk so users can customize
	await ensureDefaultPrompts(ctx.cwd);

	const diffs = await gatherDiffs(pi, ctx.cwd, files, options);
	const contents =
		contextMode !== "diff" ? await gatherContents(ctx.cwd, files) : undefined;
	const projectIndex =
		contextMode !== "diff" ? await getProjectIndex(ctx.cwd) : undefined;

	const fileList = files.map((f) => f.path).join(", ");

	// Confirmation (respect config)
	if (config.confirmBeforeRun !== false) {
		const contextLabel =
			contextMode === "diff" ? "diff only" : "full file + project index";
		const scopeLabel = options.all ? "full project scan" : "changed files";
		const ok = await ctx.ui.confirm(
			"DRYKISS Review",
			`Review ${files.length} file(s) (${scopeLabel}) with 6 parallel lens reviews + synthesis.\nContext: ${contextLabel}\n\nFiles: ${fileList}\n\nProceed?`,
		);
		if (!ok) {
			ctx.ui.notify("Review cancelled.", "info");
			return;
		}
	}

	try {
		const lenses: ReviewLens[] = [
			"simplicity",
			"deduplication",
			"clarity",
			"resilience",
			"architecture",
			"tests",
		];
		const lensReviews = await Promise.all(
			lenses.map((lens) =>
				runLensReview(ctx, ctx.cwd, files, diffs, lens, {
					modelHint: options.model,
					contents,
					projectIndex,
				}),
			),
		);

		const synthesis = await runSynthesis(
			ctx,
			ctx.cwd,
			lensReviews.map((r) => ({ lens: r.lens, rawOutput: r.rawOutput })),
			options.model,
		);

		const persistPath = await saveReview(
			ctx.cwd,
			files.map((f) => f.path),
			synthesis,
		);

		const report = formatReviewForDisplay({
			timestamp: new Date().toISOString(),
			files: files.map((f) => f.path),
			...synthesis,
		});

		ctx.ui.notify(
			report,
			synthesis.criticalCount > 0
				? "error"
				: synthesis.highCount > 0
					? "warning"
					: "info",
		);
		ctx.ui.notify(`Review persisted to: ${persistPath}`, "info");
	} catch (err: any) {
		ctx.ui.notify(`DRYKISS review failed: ${err.message}`, "error");
	}
}

export async function handleKissCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const options = parseArgs(args);
	const files = await getChangedFiles(pi, ctx.cwd, options);

	if (files.length === 0) {
		ctx.ui.notify("No changed files found.", "info");
		return;
	}

	await ensureDefaultPrompts(ctx.cwd);
	const diffs = await gatherDiffs(pi, ctx.cwd, files, options);
	const config = await loadConfig(ctx.cwd);
	const contents =
		config.contextMode !== "diff"
			? await gatherContents(ctx.cwd, files)
			: undefined;

	try {
		const review = await runLensReview(
			ctx,
			ctx.cwd,
			files,
			diffs,
			"simplicity",
			{
				modelHint: options.model,
				contents,
			},
		);
		const display =
			review.findings
				.map(
					(f) =>
						`[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? ""} — ${f.category}: ${f.summary}`,
				)
				.join("\n") || "No simplicity concerns found.";
		ctx.ui.notify(`## KISS Review (${review.modelName})\n\n${display}`, "info");
	} catch (err: any) {
		ctx.ui.notify(`KISS review failed: ${err.message}`, "error");
	}
}

export async function handleDryCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const options = parseArgs(args);
	const files = await getChangedFiles(pi, ctx.cwd, options);

	if (files.length === 0) {
		ctx.ui.notify("No changed files found.", "info");
		return;
	}

	await ensureDefaultPrompts(ctx.cwd);
	const diffs = await gatherDiffs(pi, ctx.cwd, files, options);
	const config = await loadConfig(ctx.cwd);
	const contents =
		config.contextMode !== "diff"
			? await gatherContents(ctx.cwd, files)
			: undefined;
	const projectIndex =
		config.contextMode !== "diff" ? await getProjectIndex(ctx.cwd) : undefined;

	try {
		const review = await runLensReview(
			ctx,
			ctx.cwd,
			files,
			diffs,
			"deduplication",
			{
				modelHint: options.model,
				contents,
				projectIndex,
			},
		);
		const display =
			review.findings
				.map(
					(f) =>
						`[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? ""} — ${f.category}: ${f.summary}`,
				)
				.join("\n") || "No duplication concerns found.";
		ctx.ui.notify(`## DRY Review (${review.modelName})\n\n${display}`, "info");
	} catch (err: any) {
		ctx.ui.notify(`DRY review failed: ${err.message}`, "error");
	}
}

export async function handleResilienceCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const options = parseArgs(args);
	const files = await getChangedFiles(pi, ctx.cwd, options);

	if (files.length === 0) {
		ctx.ui.notify("No changed files found.", "info");
		return;
	}

	await ensureDefaultPrompts(ctx.cwd);
	const diffs = await gatherDiffs(pi, ctx.cwd, files, options);
	const config = await loadConfig(ctx.cwd);
	const contents =
		config.contextMode !== "diff"
			? await gatherContents(ctx.cwd, files)
			: undefined;

	try {
		const review = await runLensReview(
			ctx,
			ctx.cwd,
			files,
			diffs,
			"resilience",
			{
				modelHint: options.model,
				contents,
			},
		);
		const display =
			review.findings
				.map(
					(f) =>
						`[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? ""} — ${f.category}: ${f.summary}`,
				)
				.join("\n") || "No resilience concerns found.";
		ctx.ui.notify(
			`## Resilience Review (${review.modelName})\n\n${display}`,
			"info",
		);
	} catch (err: any) {
		ctx.ui.notify(`Resilience review failed: ${err.message}`, "error");
	}
}

export async function handleTestsCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const options = parseArgs(args);
	const files = await getChangedFiles(pi, ctx.cwd, options);

	if (files.length === 0) {
		ctx.ui.notify("No changed files found.", "info");
		return;
	}

	await ensureDefaultPrompts(ctx.cwd);
	const diffs = await gatherDiffs(pi, ctx.cwd, files, options);
	const config = await loadConfig(ctx.cwd);
	const contents =
		config.contextMode !== "diff"
			? await gatherContents(ctx.cwd, files)
			: undefined;

	try {
		const review = await runLensReview(ctx, ctx.cwd, files, diffs, "tests", {
			modelHint: options.model,
			contents,
		});
		const display =
			review.findings
				.map(
					(f) =>
						`[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? ""} — ${f.category}: ${f.summary}`,
				)
				.join("\n") || "No test coverage gaps found.";
		ctx.ui.notify(
			`## Test Coverage Review (${review.modelName})\n\n${display}`,
			"info",
		);
	} catch (err: any) {
		ctx.ui.notify(`Test coverage review failed: ${err.message}`, "error");
	}
}

export async function handleArchCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const options = parseArgs(args);
	const files = await getChangedFiles(pi, ctx.cwd, options);

	if (files.length === 0) {
		ctx.ui.notify("No changed files found.", "info");
		return;
	}

	await ensureDefaultPrompts(ctx.cwd);
	const diffs = await gatherDiffs(pi, ctx.cwd, files, options);
	const config = await loadConfig(ctx.cwd);
	const contents =
		config.contextMode !== "diff"
			? await gatherContents(ctx.cwd, files)
			: undefined;
	const projectIndex =
		config.contextMode !== "diff" ? await getProjectIndex(ctx.cwd) : undefined;

	try {
		const review = await runLensReview(
			ctx,
			ctx.cwd,
			files,
			diffs,
			"architecture",
			{
				modelHint: options.model,
				contents,
				projectIndex,
			},
		);
		const display =
			review.findings
				.map(
					(f) =>
						`[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? ""} — ${f.category}: ${f.summary}`,
				)
				.join("\n") || "No architecture concerns found.";
		ctx.ui.notify(
			`## Architecture Review (${review.modelName})\n\n${display}`,
			"info",
		);
	} catch (err: any) {
		ctx.ui.notify(`Architecture review failed: ${err.message}`, "error");
	}
}

// ── Tool parameter schema ─────────────────────────────────

export const DrykissReviewParams = Type.Object({
	lens: StringEnum(
		[
			"simplicity",
			"deduplication",
			"clarity",
			"resilience",
			"architecture",
			"tests",
		] as const,
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
			| "tests";
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
	const diffs = await gatherDiffs(pi, ctx.cwd, filesToReview, options);
	const config = await loadConfig(ctx.cwd);
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
