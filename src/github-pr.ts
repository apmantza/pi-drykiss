/**
 * GitHub PR integration — fetches PR diffs and file contents via `gh` CLI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile } from "./types.js";
import { detectLanguage } from "./git-diff.js";

const execFileAsync = promisify(execFile);

export interface PrInfo {
	owner: string;
	repo: string;
	number: number;
}

export interface PrDiffResult {
	/** Changed files with status and language */
	files: ChangedFile[];
	/** Unified diff per file path */
	diffs: Map<string, string>;
	/** PR title for display */
	title: string;
	/** PR head SHA for fetching full contents */
	headSha: string;
}

/**
 * Parse a PR URL or shorthand into owner/repo/number.
 *
 * Supported formats:
 * - https://github.com/owner/repo/pull/123
 * - github.com/owner/repo/pull/123
 * - owner/repo#123
 * - 123 (uses git remote to determine owner/repo)
 */
export function parsePrUrl(input: string, gitRemote?: string): PrInfo | null {
	const trimmed = input.trim();

	// Full GitHub URL: https://github.com/owner/repo/pull/123
	const urlMatch = trimmed.match(
		/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
	);
	if (urlMatch) {
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: parseInt(urlMatch[3], 10),
		};
	}

	// Shorthand: owner/repo#123
	const shorthandMatch = trimmed.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (shorthandMatch) {
		return {
			owner: shorthandMatch[1],
			repo: shorthandMatch[2],
			number: parseInt(shorthandMatch[3], 10),
		};
	}

	// Just a number: use git remote
	const numberMatch = trimmed.match(/^\d+$/);
	if (numberMatch && gitRemote) {
		const remoteMatch = gitRemote.match(
			/(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/.]+)/,
		);
		if (remoteMatch) {
			return {
				owner: remoteMatch[1],
				repo: remoteMatch[2],
				number: parseInt(trimmed, 10),
			};
		}
	}

	return null;
}

/**
 * Check if `gh` CLI is available.
 */
export async function isGhAvailable(): Promise<boolean> {
	try {
		await execFileAsync("gh", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the git remote URL for the current repo.
 */
export async function getGitRemote(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["remote", "get-url", "origin"],
			{
				cwd,
			},
		);
		return stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Fetch PR diff using `gh pr diff`.
 * Returns the unified diff output.
 */
async function fetchPrDiffRaw(
	cwd: string,
	owner: string,
	repo: string,
	number: number,
): Promise<string> {
	const { stdout } = await execFileAsync(
		"gh",
		["pr", "diff", String(number), "--repo", `${owner}/${repo}`],
		{ cwd, maxBuffer: 10 * 1024 * 1024 }, // 10MB buffer for large diffs
	);
	return stdout;
}

/**
 * Fetch PR metadata (title, head SHA) using `gh pr view`.
 */
async function fetchPrMetadata(
	cwd: string,
	owner: string,
	repo: string,
	number: number,
): Promise<{ title: string; headSha: string }> {
	const { stdout } = await execFileAsync(
		"gh",
		[
			"pr",
			"view",
			String(number),
			"--repo",
			`${owner}/${repo}`,
			"--json",
			"title,headRefOid",
		],
		{ cwd },
	);
	const data = JSON.parse(stdout);
	return {
		title: data.title,
		headSha: data.headRefOid,
	};
}

/**
 * Parse a unified diff into ChangedFile[] and a Map of path → diff.
 */
function parseUnifiedDiff(diffOutput: string): {
	files: ChangedFile[];
	diffs: Map<string, string>;
} {
	const files: ChangedFile[] = [];
	const diffs = new Map<string, string>();

	// Split by diff headers: diff --git a/... b/...
	const diffBlocks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const block of diffBlocks) {
		// Extract file path from: a/path b/path
		const pathMatch = block.match(/^(?:a\/(.+?) )?b\/(.+)$/m);
		if (!pathMatch) continue;

		const filePath = pathMatch[2];

		// Determine status from the diff header
		let status: ChangedFile["status"] = "modified";
		if (block.match(/^new file mode/m)) {
			status = "added";
		} else if (block.match(/^deleted file mode/m)) {
			status = "deleted";
		} else if (block.match(/^rename from/m)) {
			status = "renamed";
		}

		// Detect language from file extension
		const language = detectLanguage(filePath);

		files.push({ path: filePath, status, language });
		diffs.set(filePath, "diff --git " + block);
	}

	return { files, diffs };
}

/**
 * Fetch full file contents for context using `gh api`.
 */
export async function fetchPrFileContents(
	cwd: string,
	owner: string,
	repo: string,
	sha: string,
	filePaths: string[],
): Promise<
	Map<string, { content: string; lineCount: number; truncated: boolean }>
> {
	const contents = new Map<
		string,
		{ content: string; lineCount: number; truncated: boolean }
	>();

	// Fetch files in parallel (batch of 5 to avoid rate limits)
	const BATCH_SIZE = 5;
	for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
		const batch = filePaths.slice(i, i + BATCH_SIZE);
		const results = await Promise.allSettled(
			batch.map(async (path) => {
				try {
					const { stdout } = await execFileAsync(
						"gh",
						[
							"api",
							`repos/${owner}/${repo}/contents/${path}`,
							"--jq",
							".content",
							"-H",
							"Accept: application/vnd.github.v3+json",
							"-F",
							`ref=${sha}`,
						],
						{ cwd, maxBuffer: 1 * 1024 * 1024 }, // 1MB per file
					);

					// gh api returns base64-encoded content
					const decoded = Buffer.from(stdout.trim(), "base64").toString(
						"utf-8",
					);
					const lineCount = decoded.split("\n").length;

					// Truncate if too large (same as local files)
					const MAX_LINES = 2000;
					const truncated = lineCount > MAX_LINES;
					const content = truncated
						? decoded.split("\n").slice(0, MAX_LINES).join("\n") +
							"\n... (truncated)"
						: decoded;

					return { path, content, lineCount, truncated };
				} catch (err) {
					console.warn(
						`[DRYKISS] Could not fetch content for ${path}:`,
						err instanceof Error ? err.message : String(err),
					);
					return null;
				}
			}),
		);

		for (let j = 0; j < results.length; j++) {
			const result = results[j];
			if (result.status === "fulfilled" && result.value) {
				const { path, content, lineCount, truncated } = result.value;
				contents.set(path, { content, lineCount, truncated });
			}
		}
	}

	return contents;
}

/**
 * Fetch a PR's diff and metadata using `gh` CLI.
 *
 * @param cwd - Working directory (for gh auth context)
 * @param owner - GitHub repo owner
 * @param repo - GitHub repo name
 * @param number - PR number
 * @returns PR diff result with files, diffs, title, and head SHA
 */
export async function fetchPrDiff(
	cwd: string,
	owner: string,
	repo: string,
	number: number,
): Promise<PrDiffResult> {
	// Fetch diff and metadata in parallel
	const [diffOutput, metadata] = await Promise.all([
		fetchPrDiffRaw(cwd, owner, repo, number),
		fetchPrMetadata(cwd, owner, repo, number),
	]);

	const { files, diffs } = parseUnifiedDiff(diffOutput);

	return {
		files,
		diffs,
		title: metadata.title,
		headSha: metadata.headSha,
	};
}

/**
 * Detect if a string looks like a PR reference (URL or shorthand).
 */
export function isPrReference(input: string): boolean {
	const trimmed = input.trim();
	return (
		/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(trimmed) ||
		/^[^/]+\/[^#]+#\d+$/.test(trimmed) ||
		/^\d+$/.test(trimmed)
	);
}
