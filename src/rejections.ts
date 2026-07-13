/**
 * Recorded-rejection store: persist findings the user dismissed (or that
 * another mechanism marked as not-actionable), and on later runs downrank
 * findings that match a past rejection — but never hide them.
 *
 * Failure-tolerant by design: any FS or parse error degrades to "no
 * rejections" so a review is never broken by a missing/garbled store. The
 * store is project-local (`.pi/drykiss/rejections.jsonl`) so different
 * codebases don't share their "this is noise" judgments.
 *
 * Design notes:
 * - We persist the *fields that matter for matching* (file, line, severity,
 *   message) and a timestamp. We do NOT persist the full Finding — the
 *   schema can change between releases and a stale full copy would
 *   cause type errors on load.
 * - "Same bug" is deterministic: file match + (line within ±3 with
 *   ≥25% jaccard) OR (no line on either side with ≥50% jaccard). This
 *   is the same heuristic the Bugbot-style bucketer uses, so a finding
 *   that a previous run recorded as rejected will match the
 *   near-duplicate of itself that a fresh lens surfaces — even if the
 *   new lens worded it differently.
 * - "Never hide" is enforced by the API: `applyRejections` always
 *   returns the input findings unchanged in count — it just reorders
 *   them so previously-rejected ones sink to the bottom.
 */

import {
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { getProjectBaseDir, LOG_PREFIX, SEVERITY_VALUES } from "./constants.js";
import type { Finding, Severity } from "./types.js";

/** Maximum number of rejection records to keep. Oldest are dropped past this. */
export const DEFAULT_REJECTION_CAP = 200;

/** Default filename inside the project base dir. */
export const REJECTIONS_FILE = "rejections.jsonl";

/**
 * Maximum allowed message length, in characters. Code-review finding
 * summaries are typically a single sentence; a multi-megabyte string
 * is either corruption or a malicious entry, and would let one line
 * exhaust the process heap during tokenize. Cap defensively.
 */
export const MAX_MESSAGE_LENGTH = 10_000;

/**
 * Maximum allowed rejection-store file size, in bytes. The store is
 * capped at ~200 records × ~150 bytes = ~30KB, so a 1MB file is
 * either a runaway append or a malicious edit. Reject before read
 * to prevent OOM.
 */
export const MAX_STORE_BYTES = 1_048_576;

/** File mode for the rejection store: owner read/write only. */
const STORE_FILE_MODE = 0o600;

/** A persisted record of a finding the user (or system) marked as not-actionable. */
export interface RejectionRecord {
	readonly file: string;
	readonly line?: number;
	readonly severity: Severity;
	/** The finding's summary text — used for similarity matching. */
	readonly message: string;
	/** ISO timestamp of when the rejection was recorded. */
	readonly recorded_at: string;
	/**
	 * Free-form origin tag. Useful for distinguishing user dismissals
	 * ("user"), validator refutations ("validator"), and any future
	 * automated suppression paths. Optional for backward compat.
	 */
	readonly source?: "user" | "validator" | "auto" | string;
}

// ── Tokenization + similarity (deterministic, dependency-free) ─────────────

/** Max line distance for two findings to be considered co-located. */
export const CO_LOCATED_LINE_WINDOW = 3;
/** Min Jaccard similarity (0–1) when both findings have an anchored line. */
export const CO_LOCATED_JACCARD_THRESHOLD = 0.25;
/** Min Jaccard similarity when at least one side has no anchored line. */
export const UNANCHORED_JACCARD_THRESHOLD = 0.5;
/** Min token length to keep after stopword filtering. */
const MIN_TOKEN_LENGTH = 2;

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"into",
	"when",
	"where",
	"which",
	"while",
	"will",
	"would",
	"could",
	"should",
	"using",
	"can",
	"may",
	"might",
	"are",
	"was",
	"were",
	"has",
	"have",
	"had",
	"not",
	"but",
	"a",
	"an",
	"is",
	"of",
	"to",
	"in",
	"on",
	"it",
	"be",
	"as",
	"at",
	"or",
	"if",
	"so",
	"by",
	"we",
	"you",
	"they",
	"their",
	"our",
	"your",
	"its",
	"than",
	"also",
	"such",
	"these",
	"those",
	"then",
	"now",
	"some",
	"any",
	"all",
	"each",
	"every",
	"only",
	"just",
	"very",
	"more",
	"less",
	"other",
	"another",
	"same",
]);

/** Tokenize a finding message for similarity comparison. Pure. */
export function tokenize(message: string): Set<string> {
	const tokens = message
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter(
			(token) => token.length > MIN_TOKEN_LENGTH && !STOPWORDS.has(token),
		);
	return new Set(tokens);
}

/** Jaccard similarity between two token sets. Returns 0 when both are
 *  empty — two empty token sets mean "no evidence on either side,"
 *  not "perfect match." Returns 0 for empty sets, in [0, 1] otherwise. */
export function jaccard(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) if (right.has(token)) intersection += 1;
	return intersection / (left.size + right.size - intersection);
}

/**
 * Two findings are "the same bug" when they touch the same file and
 * either sit within a few lines (a strong co-location signal, so only a
 * modest text overlap is needed to fuse paraphrases) or — when at least
 * one side has no line to anchor on — read clearly similar. Pure.
 */
export function sameBug(
	candidate: { file: string; line?: number; tokens: Set<string> },
	bucket: { file: string; line?: number; tokens: Set<string> },
): boolean {
	if (candidate.file !== bucket.file) return false;
	const similarity = jaccard(candidate.tokens, bucket.tokens);
	if (candidate.line !== undefined && bucket.line !== undefined) {
		if (Math.abs(candidate.line - bucket.line) > CO_LOCATED_LINE_WINDOW)
			return false;
		return similarity >= CO_LOCATED_JACCARD_THRESHOLD;
	}
	// At least one side has no line — demand a clearer textual match.
	return similarity >= UNANCHORED_JACCARD_THRESHOLD;
}

// ── Persistence (best-effort, corruption-tolerant) ─────────────────────────

/** Compute the absolute path to the project's rejection store. */
export function getRejectionsPath(cwd: string): string {
	return join(getProjectBaseDir(cwd), REJECTIONS_FILE);
}

/**
 * Resolve the rejection-store path, returning undefined on any error
 * (e.g. cwd points outside a valid project layout). The store is
 * best-effort infrastructure — a failure to resolve its location must
 * never break a review.
 */
function safeGetRejectionsPath(cwd: string): string | undefined {
	try {
		return getRejectionsPath(cwd);
	} catch (err) {
		console.warn("%s Failed to resolve rejection store path:", LOG_PREFIX, err);
		return undefined;
	}
}

/**
 * Read the JSONL store, tolerating a missing file or garbled lines. A
 * garbled line is skipped (not fatal) so a partial write or a schema
 * bump in a future release can't brick the store.
 *
 * The store is bounded by MAX_STORE_BYTES (defense against OOM) and
 * each record is bounded by MAX_MESSAGE_LENGTH (defense against
 * multi-megabyte entries). Files exceeding either bound degrade to
 * "no rejections" with a logged warning, matching the rest of the
 * module's "never breaks a review" contract.
 */
export async function loadRejections(
	cwd: string,
	path?: string,
): Promise<RejectionRecord[]> {
	const actualPath = path ?? safeGetRejectionsPath(cwd);
	if (!actualPath) return [];
	try {
		// Reject oversize files before reading them into memory. A
		// 1MB+ rejection store is either a runaway append or a
		// malicious edit; either way we won't try to parse it.
		const info = await stat(actualPath);
		if (info.size > MAX_STORE_BYTES) {
			console.warn(
				`${LOG_PREFIX} Rejection store exceeds ${MAX_STORE_BYTES} bytes; ignoring.`,
			);
			return [];
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return [];
		console.warn("%s Failed to stat rejection store:", LOG_PREFIX, err);
		return [];
	}
	let text: string;
	try {
		text = await readFile(actualPath, "utf8");
	} catch (err) {
		console.warn("%s Failed to read rejection store:", LOG_PREFIX, err);
		return [];
	}
	const records: RejectionRecord[] = [];
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim()) continue;
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			// Validate required + optional field types so a garbled entry
			// with a string `line` or numeric `source` can't corrupt the
			// store or trip the jaccard matcher downstream. Severity is
			// checked against the project's allowed values so a future
			// schema bump doesn't silently reintroduce stale severities.
			// Message length is capped to defend against OOM from a
			// malicious or corrupted multi-megabyte entry.
			if (
				typeof parsed.file === "string" &&
				typeof parsed.message === "string" &&
				parsed.message.length <= MAX_MESSAGE_LENGTH &&
				typeof parsed.severity === "string" &&
				SEVERITY_VALUES.has(parsed.severity) &&
				typeof parsed.recorded_at === "string" &&
				(parsed.line === undefined ||
					(typeof parsed.line === "number" && Number.isInteger(parsed.line))) &&
				(parsed.source === undefined || typeof parsed.source === "string")
			) {
				records.push(parsed as unknown as RejectionRecord);
			} else {
				console.warn(
					`${LOG_PREFIX} Skipped malformed rejection record: ${raw
						.slice(0, 80)
						.replace(/[\r\n\x00\x1b]/g, "·")}`,
				);
			}
		} catch {
			console.warn(
				`${LOG_PREFIX} Skipped unparsable rejection line: ${raw
					.slice(0, 80)
					.replace(/[\r\n\x00\x1b]/g, "·")}`,
			);
		}
	}
	return records;
}

/** Does a finding match any recorded rejection (same file + co-located/similar)? */
export function matchesRejection(
	finding: { file: string; line?: number; message: string },
	rejections: readonly RejectionRecord[],
): boolean {
	if (rejections.length === 0) return false;
	const tokens = tokenize(finding.message);
	return rejections.some((record) =>
		sameBug(
			{ file: finding.file, line: finding.line, tokens },
			{
				file: record.file,
				line: record.line,
				tokens: tokenize(record.message),
			},
		),
	);
}

/**
 * Tag findings matching a past rejection and downrank them to the bottom,
 * preserving the existing order within each group. Pure.
 *
 * Never hides: input count equals output count.
 */
export function applyRejections(
	findings: readonly Finding[],
	rejections: readonly RejectionRecord[],
): Finding[] {
	if (rejections.length === 0 || findings.length === 0) return [...findings];
	// Single forward pass: separate rejected from fresh in one go,
	// avoiding the intermediate `tagged` array and repeated casts.
	// The spread object satisfies the Finding interface directly via the
	// optional `_previouslyRejected?: true` field — no type assertion needed.
	const kept: Finding[] = [];
	const downranked: Finding[] = [];
	for (const finding of findings) {
		if (
			matchesRejection(
				{ file: finding.file, line: finding.line, message: finding.summary },
				rejections,
			)
		) {
			downranked.push({ ...finding, _previouslyRejected: true });
		} else {
			kept.push(finding);
		}
	}
	return [...kept, ...downranked];
}

/** Convert findings into rejection records. Pure (apart from the `now` default). */
export function toRejectionRecords(
	findings: readonly Finding[],
	options: { source?: RejectionRecord["source"]; now?: string } = {},
): RejectionRecord[] {
	const now = options.now ?? new Date().toISOString();
	const source = options.source;
	return findings.map((finding) => ({
		file: finding.file,
		line: finding.line,
		severity: finding.severity,
		message: finding.summary,
		recorded_at: now,
		...(source ? { source } : {}),
	}));
}

/**
 * Append new rejections, deduping against existing ones and capping the
 * total. Never throws — a write failure silently no-ops so a review is
 * never broken by a stuck disk or permission error.
 *
 * Concurrency: a per-cwd Promise chain serializes concurrent in-process
 * writers so two parallel reviews in the same Node process can't
 * clobber each other's append. The chain is best-effort — a writer
 * that errors (silent) is removed from the chain so it doesn't poison
 * subsequent writes.
 *
 * Cross-process races (two separate CLI runs) are not handled: at
 * worst the second writer overwrites the first's append, losing a
 * few records on a rare concurrent run. This matches the documented
 * "best-effort, never breaks a review" design and avoids the
 * append-without-dedup path that the previous review flagged.
 *
 * Atomicity: writes go to a temp file and then `rename()` replaces the
 * target. If the process dies mid-write the original store is left
 * intact and the new content is in `<path>.tmp` for human recovery.
 *
 * The `path` argument is resolved inside the function body via
 * `safeGetRejectionsPath` so any error from `getRejectionsPath` is
 * logged and treated as "no store available" — callers see a graceful
 * no-op instead of an unhandled rejection at the boundary.
 */
const writeChains = new Map<string, Promise<unknown>>();

export async function appendRejections(
	cwd: string,
	entries: readonly RejectionRecord[],
	cap: number = DEFAULT_REJECTION_CAP,
	path?: string,
): Promise<void> {
	if (entries.length === 0) return;

	const actualPath = path ?? safeGetRejectionsPath(cwd);
	if (!actualPath) return; // path resolution failed; already logged.
	const previous = writeChains.get(cwd) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => doAppendRejections(cwd, entries, cap, actualPath));
	writeChains.set(cwd, next);
	// Self-clean: when this writer settles, drop it from the chain so
	// the next call doesn't accumulate stale entries forever.
	next.finally(() => {
		if (writeChains.get(cwd) === next) writeChains.delete(cwd);
	});
	return next;
}

async function doAppendRejections(
	cwd: string,
	entries: readonly RejectionRecord[],
	cap: number,
	path: string,
): Promise<void> {
	const tmpPath = `${path}.tmp`;
	try {
		const existing = await loadRejections(cwd, path);
		const fresh = entries.filter(
			(entry) =>
				!matchesRejection(
					{ file: entry.file, line: entry.line, message: entry.message },
					existing,
				),
		);
		if (fresh.length === 0) return;
		// Always rewrite — the store is capped at ~200 entries, so the
		// whole file is a few tens of KB. Simpler than the append-only
		// fast path and avoids the dedup-skipped-on-append edge case.
		const merged = [...existing, ...fresh].slice(-cap);
		await mkdir(dirname(path), { recursive: true });
		// Atomic replace: write to a temp file, then rename over the
		// target. rename() is atomic on POSIX, and on Windows it
		// atomically replaces the destination. If the process dies
		// mid-write, the original store is preserved and the half-
		// written content is in `<path>.tmp` for human recovery.
		const data = merged.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		await writeFile(tmpPath, data, { mode: STORE_FILE_MODE, encoding: "utf8" });
		await rename(tmpPath, path);
	} catch (err) {
		// Persisting rejections must never break a review. Best-effort
		// unlink of the half-written tmp file so it doesn't linger on
		// disk and confuse a human looking at the project dir.
		unlink(tmpPath).catch(() => undefined);
		console.warn("%s Failed to persist rejections:", LOG_PREFIX, err);
	}
}
