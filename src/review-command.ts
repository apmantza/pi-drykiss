import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { ensureDefaultPrompts } from "./prompt-builder.js";

import { loadEffectiveConfig } from "./config.js";
import { buildActiveConstraints } from "./active-constraints.js";
import { runDeepAutoreview } from "./deep-review-command.js";
import { executeFlatReview } from "./review-tool-executor.js";
import type { ReviewLens } from "./types.js";
import { LENS_NAMES } from "./types.js";
import { runScout, type ScoutResult, type ScoutStatus } from "./scout.js";
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
import { logAutoreviewEvent, logAutoreviewError } from "./logger.js";

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
		Type.Literal("docs"),
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
		Type.Union(
			[
				Type.Literal("all"),
				Type.Literal("scout"),
				...(LensNameParam as any).anyOf,
			],
			{
				description:
					"Single lens to run, or 'all' for all lenses. Use 'scout' for project mapping only. Overrides `lenses` if both are set. Default: all.",
			},
		),
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

async function runStandaloneScout(
	ctx: ExtensionContext,
	config: import("./config.js").DrykissConfig["scout"],
	modelHint: string | undefined,
	maxFiles: number,
	ignorePatterns: readonly string[] | undefined,
	signal: AbortSignal | undefined,
	onUpdate:
		| ((result: {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
		  }) => void)
		| undefined,
	correlationId: string,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: {
		result: ReviewResult;
		progress?: string;
		scout: { result?: ScoutResult; status: ScoutStatus };
	};
}> {
	let status: ScoutStatus = {
		phase: "fallback",
		reason: "Scout returned no result",
	};
	const result = await runScout(ctx, {
		cwd: ctx.cwd,
		maxFiles,
		modelHint,
		docs: config?.docs,
		ignorePatterns,
		correlationId,
		signal,
		onStatus: (nextStatus) => {
			status = nextStatus;
			safeOnUpdate(
				onUpdate,
				`Scout ${nextStatus.phase}${nextStatus.selectedFiles !== undefined ? `: ${nextStatus.selectedFiles} file(s) selected` : ""}`,
			);
		},
	});
	const errors =
		status.phase === "fallback"
			? [status.reason ?? "Scout returned no result"]
			: [];
	const outcome = finalizeReviewOutcome({
		findings: [],
		errors,
		validationIssues: [],
		healthScore: 100,
	});
	const selectedFiles = result?.files.map((file) => file.path) ?? [];
	const summary = result?.summary ?? errors[0] ?? "Scout completed";
	const reviewResult: ReviewResult = {
		jobId: `scout-${correlationId}`,
		...outcome,
		status: errors.length > 0 ? "error" : "done",
		target: {
			mode: "full",
			label: "scout",
			metadata: { correlationId, scoutStatus: status },
		},
		files: selectedFiles,
		counts: {
			total: 0,
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
			nit: 0,
			suppressed: 0,
			previouslyRejected: 0,
		},
		findings: [],
		summary,
		errors,
		validationIssues: [],
		healthScore: 100,
		scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
	};
	const payload = {
		status: status.phase,
		summary,
		selectedFiles: result?.files ?? [],
		excludedPatterns: result?.excludedPatterns ?? [],
		notDone: result?.notDone ?? [],
	};
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: {
			result: reviewResult,
			scout: { ...(result ? { result } : {}), status },
		},
	};
}

export async function executeDrykissAutoreviewTool(
	params: {
		mode?: ReviewMode;
		files?: string[];
		base?: string;
		commit?: string;
		pr?: string;
		lens?: "all" | "scout" | Exclude<ReviewLens, "all">;
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
	const correlationId = randomUUID();
	logAutoreviewEvent("autoreview.start", {
		correlationId,
		cwd: ctx.cwd,
		mode: params.mode ?? "auto",
		lens: params.lens ?? "all",
		lenses: params.lenses,
		deep: params.deep,
	});
	try {
		await ensureDefaultPrompts(ctx.cwd);
	} catch (err) {
		logAutoreviewError("autoreview.prompt_seed_error", err, { cwd: ctx.cwd });
		throw err;
	}
	const { config: effectiveConfig, warnings } = await loadEffectiveConfig(
		ctx.cwd,
	);
	for (const warning of warnings) {
		console.warn(`${LOG_PREFIX} ${warning}`);
	}
	logAutoreviewEvent("autoreview.config_loaded", {
		correlationId,
		cwd: ctx.cwd,
		scoutEnabled: effectiveConfig.scout?.enabled === true,
		contextMode: params.contextMode ?? effectiveConfig.contextMode ?? "full",
		warnings: warnings.length,
	});
	if (params.lens === "scout") {
		return runStandaloneScout(
			ctx,
			effectiveConfig.scout,
			effectiveConfig.lensModels?.scout ?? effectiveConfig.defaultModel,
			params.maxFiles ?? effectiveConfig.autoreview?.maxFiles ?? MAX_FILES,
			effectiveConfig.ignorePatterns,
			signal,
			onUpdate,
			correlationId,
		);
	}
	const suppressions = effectiveConfig.suppressions ?? [];
	const contextMode =
		params.contextMode ?? effectiveConfig.contextMode ?? "full";
	const lenses = resolveLenses(params.lens, params.lenses);
	const fileProgress = makeAutoreviewFileProgress(onUpdate);
	logAutoreviewEvent("autoreview.scope_start", {
		correlationId,
		cwd: ctx.cwd,
		mode: params.mode ?? "auto",
		scoutEnabled: effectiveConfig.scout?.enabled === true,
	});
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
			scout: effectiveConfig.scout,
			scoutModelHint:
				effectiveConfig.lensModels?.scout ?? effectiveConfig.defaultModel,
			correlationId,
			signal,
		},
		ctx,
	);
	logAutoreviewEvent("autoreview.scope_complete", {
		correlationId,
		mode: scope.mode,
		files: scope.files.length,
		scoutEnabled: scope.metadata.enabled === true,
		scoutStatus: scope.metadata.phase ?? scope.metadata.status,
		scoutReason: scope.metadata.reason,
	});

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
	const scoutNote = buildScoutNote(scope);

	// Deep mode: Bugbot-style pipeline for a single lens. Skips the
	// standard multi-lens flow and synthesis entirely; returns the
	// deep findings directly so the agent can act on them.
	if (params.deep) {
		logAutoreviewEvent("autoreview.deep_start", {
			lens: params.deep,
			files: cappedScope.files.length,
		});
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

	// Model selection and result recording live in the flat executor so this
	// command remains focused on scope and output orchestration.
	logAutoreviewEvent("autoreview.flat_start", {
		files: cappedScope.files.length,
		lenses,
		validate: params.validate !== false,
	});
	const finalResult = await executeFlatReview({
		ctx,
		pi,
		manager,
		scope: cappedScope,
		config: effectiveConfig,
		lenses,
		activeConstraints,
		suppressions,
		model: params.model,
		validate: params.validate,
		signal,
		onProgress: onUpdate
			? (job) => safeOnUpdate(onUpdate, formatReviewProgress(job))
			: undefined,
	});
	const formatMode = params.format ?? "compact";
	const jobs =
		typeof (manager as { listJobs?: unknown }).listJobs === "function"
			? (manager as { listJobs: () => ReviewJob[] }).listJobs()
			: [];
	const finalProgress = jobs.find((job) => job.id === finalResult.jobId);
	const progressLine = finalProgress
		? `${formatReviewProgress(finalProgress)}\n`
		: "";
	logAutoreviewEvent("autoreview.complete", {
		jobId: finalResult.jobId,
		findings: finalResult.counts.total,
		verdict: finalResult.verdict,
		healthScore: finalResult.healthScore,
	});
	const text =
		progressLine +
		(scoutNote ? `${scoutNote}\n` : "") +
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
function buildScoutNote(scope: ReviewScope): string {
	if (!scope.metadata || scope.mode !== "full") return "";
	if (scope.metadata.enabled !== true) return " · scout disabled";
	const status = scope.metadata.phase ?? scope.metadata.status;
	if (status === undefined) return " · scout not invoked";
	if (status === "success") {
		const selected = scope.metadata.selectedFiles;
		const total = scope.metadata.totalFiles;
		const model = scope.metadata.modelName;
		return ` · scout selected ${selected}/${total} file(s)${model ? ` via ${model}` : ""}`;
	}
	if (status === "fallback") {
		const reason =
			typeof scope.metadata.reason === "string"
				? ` (${scope.metadata.reason})`
				: "";
		return ` · scout failed; using full file list${reason}`;
	}
	return "";
}

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
