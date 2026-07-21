/**
 * Deterministic finding bucketing.
 *
 * Groups findings from multiple lenses into clusters that represent the
 * "same defect" by file + line proximity + Jaccard text similarity. The
 * synthesis LLM is then asked to reason over buckets (with a representative
 * finding per bucket) plus any unclustered findings, instead of a flat list
 * of N×M raw findings.
 *
 * Why pre-bucketing:
 *   - Cuts synthesis prompt size dramatically (N lenses × M findings →
 *     K clusters + a few stragglers).
 *   - Makes the LLM's job easier: it reasons over clusters it can
 *     compare, not over hundreds of paraphrased duplicates.
 *   - Gives every cluster a `voteCount` and a `contributingLenses` list,
 *     which becomes the `confidence` signal — independent lenses that
 *     flagged the same line are stronger evidence than one lens alone.
 *
 * Why NOT pre-bucketing alone:
 *   - The deterministic heuristic is conservative. It refuses to merge
 *     findings across files or far-apart lines, even when the LLM would
 *     judge them semantically equivalent (e.g. "this is the same bug
 *     in three callers"). The synthesis LLM is still the source of
 *     truth for cross-cluster merges.
 *
 * Design rules (same heuristic as `rejections.ts` for consistency):
 *   - Same file is a prerequisite.
 *   - If both findings have an anchored line, they cluster when within
 *     `CO_LOCATED_LINE_WINDOW` lines and ≥25% Jaccard.
 *   - If at least one side has no line, they cluster at ≥50% Jaccard.
 *
 * This is a port of the Bugbot-style bucketer (see
 * `@dreki-gg/pi-code-reviewer` `passes.ts::bucketFindings`), adapted to
 * pi-drykiss's `Finding` shape and made pure.
 */

import type { Finding, ReviewLens } from "./types.js";
import {
	CO_LOCATED_JACCARD_THRESHOLD,
	CO_LOCATED_LINE_WINDOW,
	UNANCHORED_JACCARD_THRESHOLD,
	jaccard,
	tokenize,
} from "./rejections.js";

/** A cluster of near-duplicate findings, with provenance metadata. */
export interface FindingBucket {
	/** Representative finding: highest severity wins, longest message survives. */
	readonly representative: Finding;
	/** All findings folded into this bucket (including the representative). */
	readonly members: Finding[];
	/** Number of DISTINCT lenses that contributed. */
	readonly votes: number;
	/** Distinct lens names that contributed, sorted for determinism. */
	readonly contributingLenses: ReviewLens[];
	/** File shared by all members. */
	readonly file: string;
	/** Tightened line (the first defined value, then the cluster mean — single anchor is fine). */
	readonly line?: number;
	/** Union of all member tokens, for downstream consumers. */
	readonly tokens: Set<string>;
}

/** Severity rank for picking the bucket representative. */
const SEVERITY_RANK: Record<Finding["severity"], number> = {
	critical: 5,
	high: 4,
	medium: 3,
	low: 2,
	nit: 1,
};

interface InternalBucket {
	readonly file: string;
	line?: number;
	tokens: Set<string>;
	severities: Finding["severity"][];
	messages: string[];
	members: Finding[];
	lenses: Set<ReviewLens>;
}

/**
 * Check whether a candidate finding belongs in an existing bucket under
 * the deterministic heuristic. Pure.
 */
function sameBug(
	candidate: { file: string; line?: number; tokens: Set<string> },
	bucket: InternalBucket,
): boolean {
	if (candidate.file !== bucket.file) return false;
	const similarity = jaccard(candidate.tokens, bucket.tokens);
	if (candidate.line !== undefined && bucket.line !== undefined) {
		if (Math.abs(candidate.line - bucket.line) > CO_LOCATED_LINE_WINDOW) {
			return false;
		}
		return similarity >= CO_LOCATED_JACCARD_THRESHOLD;
	}
	return similarity >= UNANCHORED_JACCARD_THRESHOLD;
}

/**
 * Bucket a flat list of findings (possibly from multiple lenses) into
 * clusters of near-duplicates. Findings without a `lens` tag are treated
 * as their own unique lens so they don't accidentally merge with
 * themselves across runs. Pure.
 */
export function bucketFindings(findings: readonly Finding[]): FindingBucket[] {
	if (findings.length === 0) return [];
	const buckets: InternalBucket[] = [];

	// Pre-tokenize all finding summaries once so the inner sameBug loop
	// does not re-tokenize a finding's summary on every bucket comparison.
	const findingTokens = new Map<Finding, Set<string>>(
		findings.map((f) => [f, tokenize(f.summary)]),
	);

	for (const finding of findings) {
		const tokens = findingTokens.get(finding)!;
		const match = buckets.find((b) =>
			sameBug({ file: finding.file, line: finding.line, tokens }, b),
		);
		if (match) {
			match.severities.push(finding.severity);
			match.messages.push(finding.summary);
			match.members.push(finding);
			if (finding.lens) match.lenses.add(finding.lens);
			// Tighten the line: prefer a defined value over undefined.
			if (match.line === undefined && finding.line !== undefined) {
				match.line = finding.line;
			}
			// Union of tokens for downstream Jaccard comparisons.
			for (const t of tokens) match.tokens.add(t);
		} else {
			buckets.push({
				file: finding.file,
				...(finding.line !== undefined ? { line: finding.line } : {}),
				tokens,
				severities: [finding.severity],
				messages: [finding.summary],
				members: [finding],
				lenses: new Set(finding.lens ? [finding.lens] : []),
			});
		}
	}

	return buckets.map(materializeBucket);
}

/** Collapse an internal bucket to a public FindingBucket with a representative. */
function materializeBucket(b: InternalBucket): FindingBucket {
	// Pick the highest-severity finding as the representative base.
	// Tiebreak: longest message, then earliest line.
	let representative = b.members[0];
	for (const m of b.members) {
		if (
			SEVERITY_RANK[m.severity] > SEVERITY_RANK[representative.severity] ||
			(SEVERITY_RANK[m.severity] === SEVERITY_RANK[representative.severity] &&
				m.summary.length > representative.summary.length)
		) {
			representative = m;
		}
	}
	const contributingLenses = [...b.lenses].sort((a, b) => a.localeCompare(b));
	return {
		representative,
		members: b.members,
		votes: b.lenses.size,
		contributingLenses,
		file: b.file,
		...(b.line !== undefined ? { line: b.line } : {}),
		tokens: b.tokens,
	};
}

/**
 * Convert a FindingBucket into a Finding annotated with bucket metadata,
 * so the synthesis LLM can see provenance without us leaking the
 * internal-bucket shape into its input format. Pure.
 *
 * The `_bucketVotes` and `_bucketLenses` fields are internal markers
 * (see `Finding` type) and are not part of the LLM output contract.
 */
export function bucketToFinding(bucket: FindingBucket): Finding {
	const { representative } = bucket;
	return {
		...representative,
		// Override AFTER the spread: the representative (highest severity)
		// may have no line, but the bucket's aggregated line is tightened to
		// the first defined member line. Spreading representative first would
		// clobber this with `line: undefined`.
		line: bucket.line ?? representative.line,
		_bucketVotes: bucket.votes,
		_bucketLenses: bucket.contributingLenses,
	};
}

/**
 * Cluster a flat list of findings into buckets, then flatten back to
 * findings annotated with `_bucketVotes` / `_bucketLenses`. Stragglers
 * (singletons) keep their original fields and get `_bucketVotes: 1`.
 * Pure; the canonical entry point for callers.
 */
export function clusterAndFlatten(findings: readonly Finding[]): Finding[] {
	if (findings.length === 0) return [];
	const buckets = bucketFindings(findings);
	return buckets.map((bucket) => {
		if (bucket.votes <= 1) {
			// Singleton: just add the marker, no merging.
			return { ...bucket.representative, _bucketVotes: 1, _bucketLenses: [] };
		}
		return bucketToFinding(bucket);
	});
}

/**
 * Sanitize a string before interpolating it into an LLM prompt.
 * Strips control characters (except ordinary whitespace) and caps length
 * to reduce the attack surface for prompt injection via finding fields.
 */
function sanitizePromptString(value: string): string {
	return value
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/`/g, "'")
		.trim()
		.slice(0, 500);
}

/**
 * Format a list of bucketed findings as a "Bucket N: ..." block for the
 * synthesis prompt. Pure; produces a compact representation the LLM can
 * reason over (file:line, severity, votes, contributing lenses, the
 * representative summary).
 */
export function formatBucketsForPrompt(findings: readonly Finding[]): string {
	if (findings.length === 0) return "";
	return findings
		.map((f, index) => {
			const where = f.line ? `${f.file}:${f.line}` : f.file;
			const votes = f._bucketVotes ?? 1;
			const lenses =
				f._bucketLenses && f._bucketLenses.length > 0
					? `, lenses=${f._bucketLenses.join("+")}`
					: "";
			const voteLabel = votes > 1 ? ` (${votes} votes${lenses})` : "";
			return `[${index}] (${f.severity}) ${where}${voteLabel}\n    ${sanitizePromptString(f.summary)}`;
		})
		.join("\n\n");
}
