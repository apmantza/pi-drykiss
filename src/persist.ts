import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Finding, SynthesisResult } from "./types.js";
import { redactSecrets } from "./secret-redaction.js";
import { getGlobalBaseDir, LOG_PREFIX } from "./constants.js";

function getGlobalReviewsDir(): string {
	return join(getGlobalBaseDir(), "reviews");
}

function getGlobalSessionsDir(): string {
	return join(getGlobalBaseDir(), "sessions");
}

/** Redact secret-like strings before review data is persisted to disk. */
function redactPersistedValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value).text;
	if (Array.isArray(value)) return value.map(redactPersistedValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key,
				redactPersistedValue(nested),
			]),
		);
	}
	return value;
}

export interface PersistedReview {
	readonly timestamp: string;
	readonly files: string[];
	readonly findings: Finding[];
	readonly summary: string;
	readonly criticalCount: number;
	readonly highCount: number;
	readonly mediumCount: number;
	readonly lowCount: number;
	readonly nitCount: number;
	readonly suppressedCount: number;
	readonly verdict: string;
}

export async function saveReview(
	files: string[],
	synthesis: SynthesisResult,
): Promise<string> {
	const dir = getGlobalReviewsDir();
	await mkdir(dir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suppressedCount = synthesis.findings.filter(
		(f: any) => f._suppressed === true,
	).length;

	const safeSynthesis = redactPersistedValue(synthesis) as SynthesisResult;
	const review: PersistedReview = {
		timestamp,
		files,
		findings: safeSynthesis.findings,
		summary: safeSynthesis.summary,
		criticalCount: safeSynthesis.criticalCount,
		highCount: synthesis.highCount,
		mediumCount: synthesis.mediumCount,
		lowCount: synthesis.lowCount,
		nitCount: synthesis.nitCount,
		suppressedCount,
		verdict: synthesis.verdict,
	};

	const path = join(dir, `${timestamp}.json`);
	await writeFile(path, JSON.stringify(review, null, 2), "utf8");
	return path;
}

/**
 * Persist a subagent session transcript as JSONL so the user can open it
 * with an external tool (or `/resume` it in Pi). The output is Pi's
 * standard session format — one header line followed by one entry per
 * message.
 *
 * Returns the absolute path to the written file. If the session is
 * undefined (lens never produced one) or the export throws (e.g. session
 * is already disposed), returns undefined so the caller can degrade
 * gracefully — the session is still accessible via /drykiss-jobs.
 */
export async function saveSessionLog(
	jobId: string,
	lens: string,
	session: { exportToJsonl: (outputPath: string) => string } | undefined,
): Promise<string | undefined> {
	if (!session) return undefined;
	const dir = getGlobalSessionsDir();
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${jobId}-${lens}.jsonl`);
	try {
		const resolved = session.exportToJsonl(path);
		// exportToJsonl returns the resolved output path; prefer it in case
		// the implementation ever normalises or rewrites the path.
		return resolved || path;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(
			`${LOG_PREFIX} Failed to export session log for ${lens}: ${msg}`,
		);
		return undefined;
	}
}

/** Build a `file://` URL from an absolute path, suitable for OSC 8 hyperlinks. */
export function pathToFileLink(absolutePath: string): string {
	return pathToFileURL(absolutePath).toString();
}

export async function listReviews(): Promise<PersistedReview[]> {
	const dir = getGlobalReviewsDir();
	try {
		const entries = await readdir(dir);
		const reviews: PersistedReview[] = [];
		for (const entry of entries.filter((e) => e.endsWith(".json"))) {
			try {
				const raw = await readFile(join(dir, entry), "utf8");
				reviews.push(JSON.parse(raw) as PersistedReview);
			} catch {
				// skip corrupt files
			}
		}
		return reviews.sort(
			(a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		);
	} catch (err) {
		const code =
			err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		// Log unexpected errors (e.g., permission denied) so users know why list is empty
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`${LOG_PREFIX} Failed to list reviews: ${msg}`);
		return [];
	}
}

/* ── Health Score History ───────────────────────────────────── */

export interface ReviewHistoryEntry {
	readonly date: string;
	readonly mode: string;
	readonly score: number;
	readonly breakdown: {
		readonly critical: number;
		readonly warning: number;
		readonly suggestion: number;
	};
	readonly totalFindings: number;
	readonly verdict: string;
	/** Per-file finding counts for this run. Keys are normalized file paths. */
	readonly fileCounts?: Record<string, number>;
	/** Per-risk-code finding counts for this run. Keys are riskCode strings. */
	readonly riskCodeCounts?: Record<string, number>;
}

function getGlobalHistoryPath(): string {
	return join(getGlobalBaseDir(), "history.json");
}

/**
 * Load the health-score history from disk.
 * Returns an empty array if the file doesn't exist or is corrupt.
 */
export async function loadHistory(): Promise<ReviewHistoryEntry[]> {
	try {
		const raw = await readFile(getGlobalHistoryPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed as ReviewHistoryEntry[];
		return [];
	} catch (e) {
		// ENOENT = file doesn't exist yet, expected on first run
		// Other errors (corrupt JSON, permissions) should be surfaced
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(
				"DRYKISS: Failed to load health score history:",
				(e as Error).message,
			);
		}
		return [];
	}
}

/**
 * Append a new entry to the health-score history.
 * Loads existing entries, appends the new one, writes back.
 */
export async function appendHistory(entry: ReviewHistoryEntry): Promise<void> {
	try {
		const dir = getGlobalBaseDir();
		await mkdir(dir, { recursive: true });
		const existing = await loadHistory();
		// Avoid duplicates: skip if the same date/mode/breakdown combo already exists
		const isDuplicate = existing.some(
			(e) =>
				e.date === entry.date &&
				e.mode === entry.mode &&
				e.breakdown.critical === entry.breakdown.critical &&
				e.breakdown.warning === entry.breakdown.warning &&
				e.breakdown.suggestion === entry.breakdown.suggestion &&
				e.totalFindings === entry.totalFindings,
		);
		if (isDuplicate) return;
		existing.push(entry);
		// Keep at most 100 entries (newest first for writing convenience)
		const trimmed = existing.slice(-100);
		await writeFile(
			getGlobalHistoryPath(),
			JSON.stringify(trimmed, null, 2),
			"utf8",
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`${LOG_PREFIX} Failed to append health score history: ${msg}`);
	}
}

/* ── Trend query helpers ────────────────────────────────────────────── */

/**
 * Return the per-file finding counts across all history entries that include
 * `fileCounts` for the given file path.
 *
 * Each element describes one history entry and the delta relative to the
 * previous entry in the same mode (or the entry immediately before it in
 * chronological order when mode filtering is not applied by the caller).
 *
 * Only entries that contain `fileCounts` with a value for `file` are included.
 * Entries without `fileCounts` (i.e. written before this feature shipped) are
 * skipped so callers always see well-defined numeric data.
 */
export function getFileTrends(
	history: ReviewHistoryEntry[],
	file: string,
): { date: string; mode: string; current: number; previous: number; delta: number }[] {
	const relevant = history.filter(
		(e) => e.fileCounts !== undefined && file in e.fileCounts,
	);
	return relevant.map((entry, idx) => {
		const current = entry.fileCounts![file] ?? 0;
		const previous = idx > 0 ? (relevant[idx - 1].fileCounts![file] ?? 0) : current;
		return { date: entry.date, mode: entry.mode, current, previous, delta: current - previous };
	});
}

/**
 * Return the per-risk-code finding counts across all history entries that
 * include `riskCodeCounts` for the given risk code.
 *
 * Semantics mirror `getFileTrends`: only entries with `riskCodeCounts`
 * containing `code` are included; delta is relative to the previous such
 * entry.
 */
export function getRiskCodeTrends(
	history: ReviewHistoryEntry[],
	code: string,
): { date: string; mode: string; current: number; previous: number; delta: number }[] {
	const relevant = history.filter(
		(e) => e.riskCodeCounts !== undefined && code in e.riskCodeCounts,
	);
	return relevant.map((entry, idx) => {
		const current = entry.riskCodeCounts![code] ?? 0;
		const previous = idx > 0 ? (relevant[idx - 1].riskCodeCounts![code] ?? 0) : current;
		return { date: entry.date, mode: entry.mode, current, previous, delta: current - previous };
	});
}

/**
 * Return the files whose finding counts have increased the most between the
 * last two history entries that contain `fileCounts` data.
 *
 * Only entries with `fileCounts` are considered; if fewer than two such entries
 * exist the function returns an empty array.
 *
 * @param history - The full history array (chronological order, newest last).
 * @param limit   - Maximum number of results to return. Defaults to 5.
 * @returns Files sorted by `delta` descending (most worsened first). Files
 *          with a zero or negative delta are excluded.
 */
export function getWorseningFiles(
	history: ReviewHistoryEntry[],
	limit = 5,
): { file: string; delta: number }[] {
	const withCounts = history.filter((e) => e.fileCounts !== undefined);
	if (withCounts.length < 2) return [];

	const latest = withCounts[withCounts.length - 1].fileCounts!;
	const prev = withCounts[withCounts.length - 2].fileCounts!;

	// Union of all file keys present in either entry
	const allFiles = new Set([...Object.keys(latest), ...Object.keys(prev)]);

	const results: { file: string; delta: number }[] = [];
	for (const file of allFiles) {
		const delta = (latest[file] ?? 0) - (prev[file] ?? 0);
		if (delta > 0) results.push({ file, delta });
	}

	return results.sort((a, b) => b.delta - a.delta).slice(0, limit);
}

export function formatReviewForDisplay(review: PersistedReview): string {
	const sevOrder: Array<"critical" | "high" | "medium" | "low" | "nit"> = [
		"critical",
		"high",
		"medium",
		"low",
		"nit",
	];

	let md = `# KISS/DRY Review Report\n\n`;
	md += `**Files:** ${review.files.join(", ")}\n\n`;
	md += `## Summary\n`;
	md += `- Total findings: ${review.findings.length}`;
	md += ` (${review.criticalCount} critical, ${review.highCount} high, ${review.mediumCount} medium, ${review.lowCount} low, ${review.nitCount} nit`;
	if (review.suppressedCount > 0)
		md += `, ${review.suppressedCount} suppressed`;
	md += `)
`;
	md += `- ${review.summary}\n`;
	md += `- **Verdict:** ${review.verdict}\n\n`;

	for (const sev of sevOrder) {
		const items = review.findings.filter((f) => f.severity === sev);
		if (items.length === 0) continue;
		md += `## ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${items.length})\n\n`;
		for (const f of items) {
			md += `### ${f.category} — ${f.file}${f.line ? ":" + f.line : ""}\n`;
			md += `- **Summary:** ${f.summary}\n`;
			if (f.detail) md += `- **Detail:** ${f.detail}\n`;
			if (f.suggestion) md += `- **Suggestion:** ${f.suggestion}\n`;
			if (f.confidence) md += `- **Confidence:** ${f.confidence}\n`;
			md += `\n`;
		}
	}

	return md;
}
