import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { ensureDefaultPrompts } from "./prompt-builder.js";

import { loadEffectiveConfig } from "./config.js";
import { buildActiveConstraints } from "./active-constraints.js";
import { loadValidatorSystemPrompt } from "./validator.js";
import type { ReviewLens, Finding, Severity } from "./types.js";
import { LENS_NAMES } from "./types.js";
import {
	resolveReviewScope,
	type ReviewMode,
	type ReviewScope,
} from "./review-scope.js";
import type { ReviewJob } from "./review-manager.js";
import type { ReviewResult } from "./review-result.js";
import { finalizeReviewOutcome } from "./review-finalizer.js";
import { formatReviewResultCompact } from "./compact-format.js";
import { formatReviewResultForTool } from "./review-output.js";
import { LOG_PREFIX } from "./constants.js";

const MAX_FILES = 40;

function safeOnUpdate(
	onUpdate:
		| ((result: {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
		  }) => void)
		| undefined,
	text: string,
	details?: unknown,
): void {
	if (!onUpdate) return;
	try {
		onUpdate({ content: [{ type: "text", text }], details });
	} catch (err) {
		console.warn(
			`${LOG_PREFIX} onUpdate callback failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ── Tool parameter schema ─────────────────────────────────

/** Shared TypeBox union of the seven DRYKISS lens names (no "all"). */
const LensNameParam = Type.Union(
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
		description: "A single DRYKISS lens name",
	},
);

export const DrykissAutoreviewParams = Type.Object({
	// ── Scope (the only thing you should think about) ────────
	// Defaults to a smart pick if omitted: staged → local → error.
	mode: Type.Optional(
		Type.Union([
			Type.Literal("local"),
			Type.Literal("staged"),
			Type.Literal("branch"),
			Type.Literal("commit"),
			Type.Literal("pr"),
			Type.Literal("full"),
			Type.Literal("files"),
		]),
	),
	// ── Scope refinements (only needed for non-default scopes) ──
	files: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific file paths to review (only when mode=files)",
		}),
	),
	base: Type.Optional(
		Type.String({
			description:
				"Base ref for branch reviews, e.g. origin/main (only when mode=branch)",
		}),
	),
	commit: Type.Optional(
		Type.String({
			description: "Commit ref for commit reviews (only when mode=commit)",
		}),
	),
	pr: Type.Optional(
		Type.String({
			description:
				"GitHub PR URL, owner/repo#123, or PR number (only when mode=pr)",
		}),
	),
	lens: Type.Optional(
		Type.Union([Type.Literal("all") as any, ...(LensNameParam as any).anyOf], {
			description:
				"Single lens to run, or 'all' for all lenses. Overrides `lenses` if both are set. Default: all.",
		}),
	),
	lenses: Type.Optional(
		Type.Union([
			Type.Literal("all"),
			Type.Array(LensNameParam, {
				description: "Subset of DRYKISS lenses to run",
			}),
		]),
	),
	// Note: the previous schema exposed `model`, `contextMode`,
	// `maxFiles`, `validate`, and `deep*` parameters. We removed
	// them from the LLM-facing schema because:
	//   - `model`     → config-driven only
	//   - `contextMode` → config setting
	//   - `maxFiles`   → config setting
	//   - `validate`   → config opt-in
	//   - `deep*`      → Bugbot deep-mode pipeline; deserves its own
	//                    tool surface
	// ── Output (rare override) ──
	format: Type.Optional(
		Type.Union([Type.Literal("compact"), Type.Literal("structured")]),
	),
});

export async function executeDrykissAutoreviewTool(
	params: {
		mode?: ReviewMode;
		files?: string[];
		base?: string;
		commit?: string;
		pr?: string;
		lens?: "all" | Exclude<ReviewLens, "all">;
		lenses?: "all" | Exclude<ReviewLens, "all">[];
		/**
		 * Internal-only: callers (deep-mode pipeline, tests) may pass
		 * a model hint. The LLM-facing tool schema (DrykissAutoreviewParams)
		 * no longer exposes this — model selection is config-driven.
		 */
		model?: string;
		contextMode?: "diff" | "full";
		maxFiles?: number;
		/**
		 * Run the selective validator stage. Defaults to true; set false only
		 * for an explicitly latency-sensitive review.
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
		details?: unknown;
	}) => void,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { result: ReviewResult; progress?: string };
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
	const lenses = resolveLenses(params.lens, params.lenses);
	const fileProgress = makeAutoreviewFileProgress(onUpdate);
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
			pathFilters: effectiveConfig.review?.pathFilters,
			onFileProgress: fileProgress,
		},
	);

	const maxFiles =
		params.maxFiles ?? effectiveConfig.autoreview?.maxFiles ?? MAX_FILES;
	if (scope.files.length === 0) {
		throw new Error("No files found for DRYKISS autoreview.");
	}
	const cappedScope = capReviewScope(scope, maxFiles);
	const capNote =
		cappedScope.files.length < scope.files.length
			? ` · capped to ${cappedScope.files.length}/${scope.files.length} file(s) by autoreview.maxFiles`
			: "";

	// Deep mode: Bugbot-style pipeline for a single lens. Skips the
	// standard multi-lens flow and synthesis entirely; returns the
	// deep findings directly so the agent can act on them.
	if (params.deep) {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Starting DRYKISS deep-${params.deep} review for ${cappedScope.label} (${cappedScope.files.length} file(s))${capNote}...`,
				},
			],
		});
		return runDeepAutoreview(
			ctx,
			cappedScope,
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

	safeOnUpdate(
		onUpdate,
		`DRYKISS autoreview progress: [${"░".repeat(10)}] 0/${lenses.length} lens(es) complete · starting ${cappedScope.label} (${cappedScope.files.length} file(s))${capNote}`,
	);

	// Build active risk-targeting constraints for the lens system prompts.
	const activeConstraints = buildActiveConstraints(
		effectiveConfig.riskTargeting,
	);

	// Model selection: config-driven only. The LLM-facing schema
	// removed `params.model` so the agent cannot override the
	// user's per-lens / autoroute / quality-gate config. Internal
	// callers (runDeepAutoreview, tests) can still pass it.
	const result = await manager.runReview(
		ctx,
		pi,
		ctx.cwd,
		cappedScope.files,
		cappedScope.diffs,
		cappedScope.contents,
		cappedScope.projectIndex,
		{
			model: params.model,
			lenses,
			target: {
				mode: cappedScope.mode,
				label: cappedScope.label,
				metadata: cappedScope.metadata,
			},
			severityOverrides: effectiveConfig.riskTargeting?.severity,
			ignorePatterns: effectiveConfig.riskTargeting?.ignore,
			suppressions,
			pathInstructions: effectiveConfig.review?.pathInstructions,
			activeConstraints,
			commands: effectiveConfig.commands,
			validate: params.validate ?? effectiveConfig.validate,
			qualityGateThreshold: effectiveConfig.qualityGate,
			findingBudget: effectiveConfig.review?.findingBudget,
			preparationErrors: cappedScope.preparationErrors,
			onProgress: onUpdate
				? (job) => safeOnUpdate(onUpdate, formatReviewProgress(job))
				: undefined,
		},
		signal,
	);

	// Ignore filtering runs inside buildReviewResult, before counts, verdict,
	// score, and persistence are derived. Do not post-process the result here.
	const finalResult: ReviewResult = result;

	try {
		manager.recordFinalResult(finalResult);
	} catch (err) {
		console.warn("%s Failed to record final review result:", LOG_PREFIX, err);
	}

	const formatMode = params.format ?? "compact";
	const jobs =
		typeof (manager as { listJobs?: unknown }).listJobs === "function"
			? (manager as { listJobs: () => ReviewJob[] }).listJobs()
			: [];
	const finalProgress = jobs.find((job) => job.id === finalResult.jobId);
	const progressLine = finalProgress
		? `${formatReviewProgress(finalProgress)}\n`
		: "";
	const text =
		progressLine +
		(formatMode === "compact"
			? formatReviewResultCompact(finalResult, {
					qualityGateThreshold: effectiveConfig.qualityGate,
				})
			: formatReviewResultForTool(finalResult, {
					qualityGateThreshold: effectiveConfig.qualityGate,
				}));

	return {
		content: [{ type: "text", text }],
		details: {
			result: finalResult,
			progress: progressLine.trimEnd() || undefined,
		},
	};
}

/**
 * Resolve the list of lenses to run from the `lens` and `lenses` params.
 *
 * - If `lens` is provided (single value or "all"), it wins.
 * - Otherwise falls back to `lenses`.
 * - Default: all lenses.
 */
function resolveLenses(
	single: "all" | Exclude<ReviewLens, "all"> | undefined,
	multi: "all" | Exclude<ReviewLens, "all">[] | undefined,
): Exclude<ReviewLens, "all">[] {
	if (single) {
		if (single === "all") return [...LENS_NAMES];
		return [single];
	}
	if (!multi || multi === "all") return [...LENS_NAMES];
	return multi.length > 0 ? multi : [...LENS_NAMES];
}

function renderAutoreviewFileProgress(
	completed: number,
	total: number,
	label: string,
): string {
	const pct =
		total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
	const width = 20;
	const filled = Math.round((pct / 100) * width);
	const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
	return `${label}… [${bar}] ${completed}/${total} (${pct}%)`;
}

function makeAutoreviewFileProgress(
	onUpdate:
		| ((result: {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
		  }) => void)
		| undefined,
): ((completed: number, total: number, label: string) => void) | undefined {
	if (!onUpdate) return undefined;
	let lastEmit = 0;
	return (completed, total, label) => {
		const now = Date.now();
		if (completed < total && now - lastEmit < 250) return;
		lastEmit = now;
		safeOnUpdate(
			onUpdate,
			renderAutoreviewFileProgress(completed, total, label),
			{ phase: "scoping", completed, total, label },
		);
	};
}

function capReviewScope(scope: ReviewScope, maxFiles: number): ReviewScope {
	const limit = Math.max(1, Math.floor(maxFiles));
	if (scope.files.length <= limit) return scope;
	const files = scope.files.slice(0, limit);
	const allowed = new Set(files.map((file) => file.path));
	return {
		...scope,
		label: `${scope.label} (first ${limit} of ${scope.files.length} files)`,
		files,
		diffs: new Map([...scope.diffs].filter(([path]) => allowed.has(path))),
		contents: scope.contents
			? new Map([...scope.contents].filter(([path]) => allowed.has(path)))
			: undefined,
		metadata: {
			...scope.metadata,
			cappedFromFileCount: scope.files.length,
			maxFiles: limit,
		},
	};
}

function formatReviewProgress(job: ReviewJob): string {
	const total = job.lenses.length;
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

	// Visual progress bar: 10 segments, filled proportionally to completed lenses.
	const barWidth = 10;
	const filled =
		total === 0 ? 0 : Math.min(barWidth, Math.round((done / total) * barWidth));
	const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

	// Show which model is running each active lens so the user can see the
	// review is making progress and which provider/model is doing work. When
	// no lens is active (including the final persisted tool output), keep a
	// compact model summary so the bar remains visible after completion.
	const formatLensModel = (lens: ReviewLens): string => {
		const state = job.states.get(lens);
		const modelName = state?.modelName ?? "unknown";
		const provider = state?.provider ? `${state.provider}/` : "";
		return `${lens} (${provider}${modelName})`;
	};
	const runningText = running.length
		? ` · running: ${running.map(formatLensModel).join(", ")}`
		: ` · models: ${job.lenses.map(formatLensModel).join(", ")}`;
	let synthesis;
	if (job.synthesisStatus === "running") {
		synthesis = " · synthesis running";
	} else if (job.synthesisStatus === "done") {
		synthesis = " · synthesis done";
	} else if (job.synthesisStatus === "error") {
		synthesis = " · synthesis error";
	} else {
		synthesis = "";
	}
	const errorText = errored ? ` · ${errored} error(s)` : "";
	return `DRYKISS autoreview progress: [${bar}] ${done}/${total} lens(es) complete${runningText}${synthesis}${errorText} · ${elapsed}s`;
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
	const validatorSystem = await loadValidatorSystemPrompt();

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
	const outcome = finalizeReviewOutcome({
		findings,
		errors: [],
		validationIssues: [],
		healthScore,
	});
	const reviewResult: ReviewResult = {
		jobId: "deep",
		clean: outcome.clean,
		status: "done",
		reviewStatus: outcome.reviewStatus,
		codeRisk: outcome.codeRisk,
		qualityGate: outcome.qualityGate,
		verdict: outcome.verdict,
		verdictSource: outcome.verdictSource,
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
