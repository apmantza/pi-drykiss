/**
 * Deep-review pipeline (Bugbot-style).
 *
 * When a single lens is run in "deep" mode, this module drives the
 * session model through several parallel adversarial passes with varied
 * focus + temperature jitter, buckets near-duplicate findings, drops
 * low-signal single-pass notes, and runs a validator pass that tries
 * to falsify each surviving candidate.
 *
 * Pipeline:
 *   1. N parallel adversarial passes (default 5), each with a
 *      different focus seed (focuses.md) and a small per-pass
 *      temperature jitter.
 *   2. Bucket near-duplicate findings across passes (Jaccard +
 *      line-proximity).
 *   3. Drop single-pass `note` findings; keep blockers, warnings,
 *      and any candidate confirmed by ≥2 distinct passes.
 *   4. Validator pass: one batched call tries to falsify each
 *      surviving candidate. Fail-open: if the validator errors, the
 *      candidates are surfaced unvalidated rather than silently
 *      dropped.
 *   5. Sort by severity, cap at `maxFindings`, return.
 *
 * This mirrors the structure Cursor describes for Bugbot
 * (parallel passes with varied reasoning → bucket → vote → validate)
 * and exists specifically to catch the class of bug a single
 * checklist pass misses — e.g. `typeof NaN === "number"` slipping a
 * boundary guard.
 *
 * Everything here is pure over the `LlmCaller` interface so it is
 * unit-testable with a deterministic fake model. The default
 * implementation, `callLlmViaPi`, uses the session's `callLLM`
 * helper and tolerates model errors.
 */

import { toErrorMessage } from "./error-utils.js";
import { parseBalancedJsonArray } from "./json-extract.js";
import { loadPromptBody } from "./prompt-loader.js";
import { parseVerdictRecord } from "./verdict-utils.js";
import {
	jaccard,
	tokenize,
	CO_LOCATED_LINE_WINDOW,
	CO_LOCATED_JACCARD_THRESHOLD,
	UNANCHORED_JACCARD_THRESHOLD,
} from "./rejections.js";
import { findModelByHint } from "./model-utils.js";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLLM } from "./llm.js";
import { LOG_PREFIX } from "./constants.js";

// ── Severity scheme for deep-mode (bugbot-style) ──────────────────────────

/** Three-tier severity used by adversarial passes. Simpler than the
 *  full DRYKISS 5-tier because the validator runs separately and
 *  re-buckets survivors to the DRYKISS scheme at the end. */
export type DeepSeverity = "blocker" | "warning" | "note";

const SEVERITY_RANK: Record<DeepSeverity, number> = {
	blocker: 3,
	warning: 2,
	note: 1,
};

const VALID_SEVERITIES = new Set<DeepSeverity>(["blocker", "warning", "note"]);

// ── Result shapes ──────────────────────────────────────────────────────────

/** A finding as emitted by one adversarial pass (before bucketing). */
export interface DeepFinding {
	readonly file: string;
	readonly line?: number;
	readonly severity: DeepSeverity;
	readonly message: string;
	readonly category?: string;
}

/** A merged bucket of near-duplicate findings across passes. */
export interface DeepCandidate extends DeepFinding {
	/** Number of DISTINCT passes that independently surfaced this. */
	readonly votes: number;
	/** Indices of the contributing passes (0-based). */
	readonly passIndices: number[];
	/** Models that caught this finding (attribution). */
	readonly models: string[];
}

/** A validator verdict for one candidate. */
export interface DeepVerdict {
	readonly id: number;
	readonly verdict: "real" | "false-positive";
	readonly confidence: number;
	readonly justification?: string;
}

/** A surviving candidate after the validator runs. */
export interface DeepValidatedFinding extends DeepCandidate {
	readonly verdict: "real";
	readonly confidence: number;
	readonly justification?: string;
	readonly models: string[];
}

/** Telemetry about the deep pipeline run. */
export interface DeepTelemetry {
	readonly passes: number;
	readonly passFindingCounts: number[];
	readonly buckets: number;
	readonly candidates: number;
	readonly validated: number;
	readonly droppedFalsePositives: number;
	readonly droppedLowSignal: number;
	readonly failedPasses: number;
	readonly passErrorSample?: string;
	readonly passModels: string[];
	readonly validatorModel: string;
}

/** Full result returned to the caller (the autoreview tool). */
export interface DeepReviewResult {
	readonly findings: DeepValidatedFinding[];
	readonly rejected: DeepCandidate[];
	readonly telemetry: DeepTelemetry;
}

/** Per-pass model assignment. The pipeline rotates through this list. */
export interface ModelAssignment {
	readonly key: string;
	readonly reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly label: string;
}

export interface ModelPlan {
	/** One assignment per pass (length === passes). */
	readonly passes: ModelAssignment[];
	/** Assignment for the validator. */
	readonly validator: ModelAssignment;
}

export interface DeepReviewConfig {
	readonly passes: number;
	readonly concurrency: number;
	readonly temperature: number;
	readonly maxFindings: number;
	readonly minVotes: number;
	/** Optional signal for aborting the pipeline. */
	readonly signal?: AbortSignal;
}

// ── LLM caller interface (pure over the model boundary) ──────────────────

export interface LlmCaller {
	complete(options: {
		modelKey: string;
		reasoning?: ModelAssignment["reasoning"];
		system: string;
		user: string;
		temperature: number;
		stage: string;
		signal?: AbortSignal;
	}): Promise<string>;
}

/** Default LLM caller: resolves the model by hint and calls the session. */
export function makePiLlmCaller(
	ctx: ExtensionContext,
): (hint: string, fallback?: Model<Api>) => Model<Api> | undefined {
	const available = ctx.modelRegistry.getAvailable();
	return (hint, fallback) => {
		const m = findModelByHint(available, hint);
		return m ?? fallback;
	};
}

/** Build a ModelPlan: rotates `passModels` round-robin across passes,
 *  uses `validatorModel` for the validator stage. When `passModels` is
 *  empty, every pass uses the session model. */
export function buildModelPlan(options: {
	passModelKey: string;
	passModelLabel: string;
	validatorModelKey: string;
	validatorModelLabel: string;
	passes: number;
}): ModelPlan {
	const passes: ModelAssignment[] = [];
	for (let i = 0; i < options.passes; i++) {
		passes.push({
			key: options.passModelKey,
			label: options.passModelLabel,
		});
	}
	return {
		passes,
		validator: {
			key: options.validatorModelKey,
			label: options.validatorModelLabel,
		},
	};
}

// ── Focus seeds (loaded from focuses.md) ─────────────────────────────────

/**
 * Load the per-pass focus seeds from `focuses.md`.
 *
 * The file contains a numbered list (1–8) of focus areas. Each item may
 * span multiple lines. This parser extracts the text of each item,
 * stripping the leading number, bold markers, and joining continuation
 * lines into a single string suitable for the PASS FOCUS block.
 *
 * Resolution order: user dir → bundled defaults (same as loadPromptBody).
 * On any read/parse error, returns an empty array so the pipeline can
 * fall back to a neutral focus string (honors the "never throws" contract).
 */
export async function loadFocusSeeds(): Promise<string[]> {
	let raw: string;
	try {
		raw = await loadPromptBody("focuses", "shared");
	} catch (err) {
		console.warn(
			"%s Failed to load focus seeds: %s",
			LOG_PREFIX,
			toErrorMessage(err),
		);
		return [];
	}

	// Parse numbered list items: lines starting with `N. ` where N is a digit.
	// Continuation lines are indented (start with spaces). Join them.
	const lines = raw.split("\n");
	const seeds: string[] = [];
	let current: string[] | null = null;

	for (const line of lines) {
		const numberedMatch = line.match(/^\d+\.\s+(.*)/);
		if (numberedMatch) {
			// Start a new seed item
			if (current !== null) {
				const joined = current.join(" ").replace(/\s+/g, " ").trim();
				if (joined.length > 0) seeds.push(joined);
			}
			// Strip bold markers (**text**) — keep the text, remove the **
			const text = numberedMatch[1].replace(/\*\*(.*?)\*\*/g, "$1");
			current = [text];
		} else if (current !== null && line.trim().length > 0) {
			// Continuation line of the current seed
			current.push(line.trim());
		}
	}
	if (current !== null) {
		const joined = current.join(" ").replace(/\s+/g, " ").trim();
		if (joined.length > 0) seeds.push(joined);
	}

	return seeds.length > 0 ? seeds : [];
}

/** Load the deep-mode pass system prompt. Cached by the caller. */
export async function loadDeepPassSystemPrompt(): Promise<string> {
	// Resolution order: user dir → bundled defaults (same as loadPromptBody).
	return loadPromptBody("pass-system", "shared");
}

// ── Parsing ───────────────────────────────────────────────────────────────

function coerceSeverity(value: unknown): DeepSeverity | null {
	return typeof value === "string" &&
		VALID_SEVERITIES.has(value as DeepSeverity)
		? (value as DeepSeverity)
		: null;
}

/** Parse one pass's raw text into validated findings. Tolerant of
 *  fences / surrounding prose. */
export function parseDeepFindings(text: string): DeepFinding[] {
	const parsed = parseBalancedJsonArray(text, (error) => {
		console.warn(
			"%s Failed to parse deep-review pass output: %s",
			LOG_PREFIX,
			toErrorMessage(error),
		);
	});
	if (!parsed) return [];
	const out: DeepFinding[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const severity = coerceSeverity(record.severity);
		const file = typeof record.file === "string" ? record.file.trim() : "";
		const message =
			typeof record.message === "string" ? record.message.trim() : "";
		if (!severity || !file || !message) continue;
		const line =
			typeof record.line === "number" &&
			Number.isInteger(record.line) &&
			record.line > 0
				? record.line
				: undefined;
		const category =
			typeof record.category === "string" ? record.category.trim() : undefined;
		out.push({ file, line, severity, message, category });
	}
	return out;
}

/** Parse the validator's raw text into a Map<id, verdict>. */
export function parseDeepVerdicts(text: string): Map<number, DeepVerdict> {
	const parsed = parseBalancedJsonArray(text, (error) => {
		console.warn(
			"%s Failed to parse deep-review validator output: %s",
			LOG_PREFIX,
			toErrorMessage(error),
		);
	});
	if (!parsed) return new Map();
	const verdicts = new Map<number, DeepVerdict>();
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) continue;
		const verdict = parseVerdictRecord(
			entry as Record<string, unknown>,
			"false-positive",
		);
		if (verdict) verdicts.set(verdict.id, verdict);
	}
	return verdicts;
}

// ── Pipeline stages ──────────────────────────────────────────────────────

/** Bucket raw per-pass findings into candidate clusters. Each cluster
 *  is a near-duplicate group across passes, with vote count =
 *  distinct contributing passes. Reuses the Jaccard helper from
 *  bucketing.ts to keep the heuristic consistent with the rest of
 *  the codebase. */
export function bucketDeepFindings(perPass: DeepFinding[][]): DeepCandidate[] {
	// Flatten per-pass findings with a passIndex tag, cluster, then
	// post-process the clusters into the DeepCandidate shape.
	const tagged: Array<DeepFinding & { passIndex: number }> = [];
	for (let i = 0; i < perPass.length; i++) {
		for (const f of perPass[i]) tagged.push({ ...f, passIndex: i });
	}

	// Same heuristic as bucketing.ts: same file + co-located line
	// (within ±3 lines) + Jaccard ≥ 0.25, OR same file + no line on
	// either side + Jaccard ≥ 0.5.
	interface InternalBucket {
		file: string;
		line?: number;
		tokens: Set<string>;
		severities: DeepSeverity[];
		messages: string[];
		categories: (string | undefined)[];
		members: Array<DeepFinding & { passIndex: number }>;
	}
	const buckets: InternalBucket[] = [];
	for (const t of tagged) {
		const tokens = tokenize(t.message);
		const match = buckets.find((b) => {
			if (b.file !== t.file) return false;
			const sim = jaccard(b.tokens, tokens);
			if (b.line !== undefined && t.line !== undefined) {
				if (Math.abs(b.line - t.line) > CO_LOCATED_LINE_WINDOW) return false;
				return sim >= CO_LOCATED_JACCARD_THRESHOLD;
			}
			return sim >= UNANCHORED_JACCARD_THRESHOLD;
		});
		if (match) {
			match.severities.push(t.severity);
			match.messages.push(t.message);
			match.categories.push(t.category);
			match.members.push(t);
			if (match.line === undefined && t.line !== undefined) match.line = t.line;
			for (const tok of tokens) match.tokens.add(tok);
		} else {
			buckets.push({
				file: t.file,
				...(t.line !== undefined ? { line: t.line } : {}),
				tokens,
				severities: [t.severity],
				messages: [t.message],
				categories: [t.category],
				members: [t],
			});
		}
	}

	return buckets.map((bucket) => {
		// Pick the highest-severity finding as the representative.
		let rep = bucket.members[0];
		for (const m of bucket.members) {
			if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[rep.severity]) {
				rep = m;
			}
		}
		// Count DISTINCT pass indices, not duplicate flags from one pass.
		const passIndices = new Set<number>();
		for (const m of bucket.members) passIndices.add(m.passIndex);
		const sortedPasses = [...passIndices].sort((a, b) => a - b);
		// Pick the most common category (if any).
		const catCounts = new Map<string, number>();
		for (const c of bucket.categories) {
			if (c) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
		}
		const category = [...catCounts.entries()].sort(
			(a, b) => b[1] - a[1],
		)[0]?.[0];
		return {
			file: rep.file,
			...(rep.line !== undefined ? { line: rep.line } : {}),
			severity: rep.severity,
			message: rep.message,
			category,
			votes: sortedPasses.length,
			passIndices: sortedPasses,
			models: [],
		};
	});
}

/** Drop low-signal single-pass notes; always keep blockers and warnings
 *  so a genuine high-severity singleton still reaches the validator. */
export function selectDeepCandidates(
	candidates: readonly DeepCandidate[],
	config: Pick<DeepReviewConfig, "minVotes">,
): { kept: DeepCandidate[]; droppedLowSignal: number } {
	const kept: DeepCandidate[] = [];
	let dropped = 0;
	for (const c of candidates) {
		if (c.severity !== "note" || c.votes >= config.minVotes) {
			kept.push(c);
		} else {
			dropped += 1;
		}
	}
	return { kept, droppedLowSignal: dropped };
}

function severitySort(
	a: DeepValidatedFinding,
	b: DeepValidatedFinding,
): number {
	const bySev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
	if (bySev !== 0) return bySev;
	if (b.votes !== a.votes) return b.votes - a.votes;
	return b.confidence - a.confidence;
}

// ── Pipeline runner ──────────────────────────────────────────────────────

export interface RunDeepReviewOptions {
	readonly baseUserPrompt: string;
	readonly config: DeepReviewConfig;
	readonly plan: ModelPlan;
	readonly passSystem: string;
	readonly validatorSystem: string;
	readonly caller: LlmCaller;
	readonly hooks?: { onStage?: (stage: string) => void };
}

/** Run the full Bugbot deep-review pipeline. Returns a
 *  DeepReviewResult; never throws. Pass failures degrade to []. */
export async function runDeepReview(
	options: RunDeepReviewOptions,
): Promise<DeepReviewResult> {
	const {
		baseUserPrompt,
		config,
		plan,
		passSystem,
		validatorSystem,
		caller,
		hooks,
	} = options;

	// Stage 1: parallel adversarial passes.
	hooks?.onStage?.(`running ${config.passes} passes`);
	const focusSeeds = await loadFocusSeeds();
	const passOutcomes: Array<{
		findings: DeepFinding[];
		failed: boolean;
		error?: string;
	}> = [];
	for (let i = 0; i < config.passes; i++) {
		const focus =
			focusSeeds.length > 0
				? focusSeeds[i % focusSeeds.length]
				: "(no focus seed available)";
		const assignment = plan.passes[i];
		const temperature = config.temperature + (i % 4) * 0.1;
		try {
			const text = await caller.complete({
				modelKey: assignment.key,
				reasoning: assignment.reasoning,
				system: passSystem,
				user: buildPassUser(baseUserPrompt, focus),
				temperature,
				stage: `pass-${i + 1}`,
				signal: config.signal,
			});
			passOutcomes.push({ findings: parseDeepFindings(text), failed: false });
		} catch (err) {
			const msg = toErrorMessage(err);
			console.warn("%s Deep pass %d failed: %s", LOG_PREFIX, i + 1, msg);
			passOutcomes.push({ findings: [], failed: true, error: msg });
		}
	}

	const perPass = passOutcomes.map((o) => o.findings);
	const failedPasses = passOutcomes.filter((o) => o.failed).length;
	const passErrorSample = passOutcomes.find((o) => o.failed)?.error;

	// Stage 2: bucket near-duplicates across passes.
	const candidates = bucketDeepFindings(perPass);

	// Stage 3: drop low-signal single-pass notes.
	const { kept, droppedLowSignal } = selectDeepCandidates(candidates, config);

	// Stage 4: validator pass.
	let validated: DeepValidatedFinding[] = [];
	let droppedFalsePositives = 0;
	const rejected: DeepCandidate[] = [];
	try {
		const text = await caller.complete({
			modelKey: plan.validator.key,
			reasoning: plan.validator.reasoning,
			system: validatorSystem,
			user: buildValidatorUser(baseUserPrompt, kept),
			temperature: 0,
			stage: "validate",
			signal: config.signal,
		});
		const verdicts = parseDeepVerdicts(text);
		// A missing verdict is "real" with default confidence 0.5
		// (fail-open). Only an explicit "false-positive" verdict drops.
		const accepted: DeepValidatedFinding[] = [];
		kept.forEach((candidate, index) => {
			const v = verdicts.get(index);
			if (v && v.verdict === "false-positive") {
				rejected.push(candidate);
				return;
			}
			accepted.push({
				...candidate,
				verdict: "real" as const,
				confidence: v?.confidence ?? 0.5,
				...(v?.justification ? { justification: v.justification } : {}),
				models: candidate.models,
			});
		});
		validated = accepted;
		droppedFalsePositives = rejected.length;
	} catch (err) {
		// Fail open: surface candidates unvalidated rather than lose them.
		const msg = toErrorMessage(err);
		console.warn(
			"%s Deep validator failed, surfacing unvalidated: %s",
			LOG_PREFIX,
			msg,
		);
		validated = kept.map((candidate) => ({
			...candidate,
			verdict: "real" as const,
			confidence: 0.5,
			justification: "(validator unavailable — surfaced unvalidated)",
			models: candidate.models,
		}));
	}

	validated.sort(severitySort);
	const capped = validated.slice(0, config.maxFindings);

	return {
		findings: capped,
		rejected,
		telemetry: {
			passes: config.passes,
			passFindingCounts: perPass.map((f) => f.length),
			buckets: candidates.length,
			candidates: kept.length,
			validated: capped.length,
			droppedFalsePositives,
			droppedLowSignal,
			failedPasses,
			passErrorSample,
			passModels: plan.passes.map((p) => p.label),
			validatorModel: plan.validator.label,
		},
	};
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildPassUser(basePrompt: string, focus: string): string {
	return [
		basePrompt,
		"",
		"---",
		`PASS FOCUS (weight your attention here, but report any bug you see): ${focus}`,
		"",
		"Return ONLY the JSON array of findings described in your instructions.",
	].join("\n");
}

function buildValidatorUser(
	basePrompt: string,
	candidates: readonly DeepCandidate[],
): string {
	const list = candidates
		.map((c, index) => {
			const where = c.line ? `${c.file}:${c.line}` : c.file;
			return `[${index}] (${c.severity}, ${c.votes} votes) ${where} — ${c.message}`;
		})
		.join("\n");
	return [
		basePrompt,
		"",
		"---",
		"CANDIDATE FINDINGS TO VALIDATE:",
		list,
		"",
		"For each candidate id above, output the verdict JSON described in your instructions.",
	].join("\n");
}

// ── Pi-backed LLM caller ─────────────────────────────────────────────────

/** Build an LlmCaller that uses the session's `callLLM` helper.
 *  The caller resolves a model by hint, falling back to the session
 *  model if the hint doesn't match. */
export function makePiCallerAdapter(
	ctx: ExtensionContext,
	fallback: Model<Api> | undefined,
): LlmCaller {
	return {
		async complete({
			modelKey,
			reasoning: _reasoning,
			system,
			user,
			temperature,
			signal,
		}) {
			const available = ctx.modelRegistry.getAvailable();
			const resolved = findModelByHint(available, modelKey) ?? fallback;
			if (!resolved) {
				throw new Error(
					`No model available for deep-review pass (hint: ${modelKey}).`,
				);
			}
			const result = await callLLM(
				ctx,
				system,
				user,
				{ temperature, signal },
				"deep-review",
			);
			return result.text;
		},
	};
}
