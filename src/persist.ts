import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Finding, SynthesisResult } from "./types.js";
import { getGlobalBaseDir, LOG_PREFIX } from "./constants.js";

function getGlobalReviewsDir(): string {
	return join(getGlobalBaseDir(), "reviews");
}

function getGlobalSessionsDir(): string {
	return join(getGlobalBaseDir(), "sessions");
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

	const review: PersistedReview = {
		timestamp,
		files,
		findings: synthesis.findings,
		summary: synthesis.summary,
		criticalCount: synthesis.criticalCount,
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
	} catch {
		return [];
	}
}

/**
 * Append a new entry to the health-score history.
 * Loads existing entries, appends the new one, writes back.
 */
export async function appendHistory(
	entry: ReviewHistoryEntry,
): Promise<void> {
	const dir = getGlobalBaseDir();
	await mkdir(dir, { recursive: true });
	const existing = await loadHistory();
	// Avoid duplicates: skip if the same date/mode/score combo already exists
	const isDuplicate = existing.some(
		(e) =>
			e.date === entry.date &&
			e.mode === entry.mode &&
			e.score === entry.score,
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
