import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, SynthesisResult } from "./types.js";
import { getGlobalBaseDir } from "./constants.js";

function getGlobalReviewsDir(): string {
	return join(getGlobalBaseDir(), "reviews");
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
	readonly verdict: string;
}

export async function saveReview(
	_cwd: string,
	files: string[],
	synthesis: SynthesisResult,
): Promise<string> {
	const dir = getGlobalReviewsDir();
	await mkdir(dir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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
		verdict: synthesis.verdict,
	};

	const path = join(dir, `${timestamp}.json`);
	await writeFile(path, JSON.stringify(review, null, 2), "utf8");
	return path;
}

export async function listReviews(_cwd: string): Promise<PersistedReview[]> {
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
	} catch {
		return [];
	}
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
	md += ` (${review.criticalCount} critical, ${review.highCount} high, ${review.mediumCount} medium, ${review.lowCount} low, ${review.nitCount} nit)\n`;
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
