/**
 * GitHub PR integration — fetches PR diffs and file contents via `gh` CLI.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedFile, Finding } from "./types.js";
import { detectLanguage } from "./git-diff.js";

/**
 * Safely encode owner/repo into a CLI-safe repo reference.
 * Prevents URL injection via special characters in owner or repo names.
 */
function safeRepoRef(owner: string, repo: string): string {
	return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

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
 * Validates owner/repo names to reject path traversal characters (.., @, :).
 * All returned owner/repo values are alphanumeric with . _ - only.
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
	// Owner/repo from URL context are already validated by the URL structure
	// (cannot contain .. or @ in a valid GitHub URL position)
	const urlMatch = trimmed.match(
		/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/pull\/(\d+)/,
	);
	if (urlMatch) {
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: Number.parseInt(urlMatch[3], 10),
		};
	}

	// Shorthand: owner/repo#123
	const shorthandMatch = trimmed.match(
		/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)$/,
	);
	if (shorthandMatch) {
		return {
			owner: shorthandMatch[1],
			repo: shorthandMatch[2],
			number: Number.parseInt(shorthandMatch[3], 10),
		};
	}

	// Just a number: use git remote
	const numberMatch = trimmed.match(/^\d+$/);
	if (numberMatch && gitRemote) {
		const remoteMatch = gitRemote.match(
			/(?:https?:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/,
		);
		if (remoteMatch) {
			return {
				owner: remoteMatch[1],
				repo: remoteMatch[2],
				number: Number.parseInt(trimmed, 10),
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
		["pr", "diff", String(number), "--repo", safeRepoRef(owner, repo)],
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
			safeRepoRef(owner, repo),
			"--json",
			"title,headRefOid",
		],
		{ cwd },
	);
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch (err) {
		throw new Error(
			`Failed to parse gh PR metadata JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (
		typeof data !== "object" ||
		data === null ||
		!("title" in data) ||
		!("headRefOid" in data) ||
		typeof data.title !== "string" ||
		typeof data.headRefOid !== "string"
	) {
		throw new Error("gh PR metadata JSON is missing title or headRefOid");
	}
	return {
		title: data.title,
		headSha: data.headRefOid,
	};
}

/**
 * Parse a unified diff into ChangedFile[] and a Map of path → diff.
 */
export function parseUnifiedDiff(diffOutput: string): {
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
 * Decode a `gh api` `.content` response (base64-encoded file content)
 * into a UTF-8 string.
 *
 * GitHub's contents API returns file content as base64. Some encoders
 * insert newlines every 76 characters, so the input may have embedded
 * whitespace that must be stripped before validation. An empty response
 * is valid (it represents a brand-new empty file).
 *
 * Returns `null` if the input doesn't look like base64 after cleanup —
 * the caller should log and skip the file rather than treating garbage
 * as content.
 */
export function decodeBase64Content(trimmed: string): string | null {
	if (trimmed.length === 0) return "";
	const cleaned = trimmed.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) return null;
	return Buffer.from(cleaned, "base64").toString("utf-8");
}

/**
 * Validate a file path before interpolating it into a URL.
 *
 * File paths in a PR diff come from the PR author — a code-review tool is
 * the wrong place to be lenient. Reject anything that could be used for
 * path traversal (`..`) or URL injection (`?`/`#`/`&`/`=`) or header
 * injection (control characters / newlines).
 *
 * Also rejects absolute paths and embedded `//` segments that would change
 * the URL structure.
 */
export function isValidFilePath(path: unknown): path is string {
	if (typeof path !== "string" || path.length === 0) return false;
	if (path.length > 4096) return false;
	if (path.startsWith("/")) return false;
	if (path.includes("//")) return false;
	// Reject control characters (incl. \n, \r, \t, \0)
	if (/[\x00-\x1f\x7f]/.test(path)) return false;
	// Reject path-traversal segments
	if (path.split("/").some((seg) => seg === ".." || seg === ".")) return false;
	// Reject URL-structural characters
	if (/[?#&=]/.test(path)) return false;
	return true;
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
				if (!isValidFilePath(path)) {
					return null;
				}
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

					// gh api returns base64-encoded content. Some encoders embed
					// newlines every 76 chars; strip any whitespace before
					// validating so multi-line responses don't get rejected.
					const decoded = decodeBase64Content(stdout);
					if (decoded === null) {
						return null;
					}
					const lineCount = decoded.split("\n").length;

					// Truncate if too large (same as local files)
					const MAX_LINES = 2000;
					const truncated = lineCount > MAX_LINES;
					const content = truncated
						? decoded.split("\n").slice(0, MAX_LINES).join("\n") +
							"\n... (truncated)"
						: decoded;

					return { path, content, lineCount, truncated };
				} catch {
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

// ── PR review posting ────────────────────────────────────────────────────

/**
 * The verdict passed to GitHub's pull request review API.
 *
 * - "APPROVE"          → marks the PR as approved.
 * - "REQUEST_CHANGES"  → requests changes from the author.
 * - "COMMENT"          → leaves a comment-only review (no approval action).
 */
export type PrReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** Result returned by `postPrReview`. */
export interface PostPrReviewResult {
	/** Whether the API call succeeded. */
	readonly success: boolean;
	/** GitHub HTML URL of the created review, when available. */
	readonly reviewUrl?: string;
	/** Human-readable error message on failure. */
	readonly error?: string;
}

/**
 * Map a DRYKISS synthesis verdict to a GitHub PR review event.
 *
 * "Approve"                → APPROVE
 * "Request changes"        → REQUEST_CHANGES
 * "Needs security review"  → REQUEST_CHANGES (security issues warrant changes)
 */
export function verdictToGitHubEvent(
	verdict: string,
): PrReviewVerdict {
	switch (verdict) {
		case "Approve":
			return "APPROVE";
		case "Request changes":
		case "Needs security review":
			return "REQUEST_CHANGES";
		default:
			return "COMMENT";
	}
}

/**
 * Format a single Finding into a Markdown body suitable for a PR review
 * inline comment.
 */
function formatFindingBody(finding: Finding): string {
	const severityEmoji: Record<string, string> = {
		critical: "🔴",
		high: "🟠",
		medium: "🟡",
		low: "🔵",
		nit: "⚪",
	};
	const icon = severityEmoji[finding.severity] ?? "⚫";
	const lines: string[] = [
		`${icon} **[${finding.severity.toUpperCase()}]** ${finding.summary}`,
	];
	if (finding.detail && finding.detail !== finding.summary) {
		lines.push("", finding.detail);
	}
	if (finding.suggestion) {
		lines.push("", `**Suggestion:** ${finding.suggestion}`);
	}
	if (finding.consequence) {
		lines.push("", `**Consequence:** ${finding.consequence}`);
	}
	if (finding.category) {
		lines.push("", `_Category: ${finding.category}_`);
	}
	return lines.join("\n");
}

/**
 * A single inline comment for the GitHub PR review API.
 */
interface GitHubReviewComment {
	path: string;
	line?: number;
	body: string;
}

/**
 * Post a PR review via `gh api` with findings mapped to inline comments.
 *
 * Findings that have a `line` number become inline comments on the specific
 * file + line. Findings without a line number are rolled up into the top-level
 * review body instead (GitHub does not allow inline comments without a line).
 *
 * @param cwd       - Working directory (for gh auth context).
 * @param owner     - GitHub repository owner.
 * @param repo      - GitHub repository name.
 * @param prNumber  - Pull request number.
 * @param findings  - Review findings to post.
 * @param verdict   - GitHub review event ("APPROVE", "REQUEST_CHANGES", or "COMMENT").
 * @param summary   - Optional overall review summary used as the review body.
 * @returns         - Success flag, review URL, and error details when applicable.
 */
export async function postPrReview(
	cwd: string,
	owner: string,
	repo: string,
	prNumber: number,
	findings: readonly Finding[],
	verdict: PrReviewVerdict,
	summary?: string,
): Promise<PostPrReviewResult> {
	// Separate findings into inline (have a line) vs. body-only (no line).
	const inlineFindings = findings.filter(
		(f) => f.line !== undefined && f.line > 0,
	);
	const bodyFindings = findings.filter(
		(f) => f.line === undefined || f.line <= 0,
	);

	// Build inline comment objects.
	const comments: GitHubReviewComment[] = inlineFindings.map((f) => ({
		path: f.file,
		line: f.line as number,
		body: formatFindingBody(f),
	}));

	// Build the top-level review body.
	const bodyParts: string[] = [];
	if (summary) {
		bodyParts.push(summary);
	}
	if (bodyFindings.length > 0) {
		if (bodyParts.length > 0) bodyParts.push("");
		bodyParts.push("## Additional findings (no specific line)");
		for (const f of bodyFindings) {
			bodyParts.push("", `**\`${f.file}\`**`);
			bodyParts.push(formatFindingBody(f));
		}
	}
	// When there are no findings at all and no summary, provide a minimal body
	// so the API call always sends a non-empty body.
	if (bodyParts.length === 0) {
		bodyParts.push("DRYKISS automated review — no findings.");
	}
	const body = bodyParts.join("\n");

	// Construct the JSON payload for `gh api --input -`.
	const payload = {
		event: verdict,
		body,
		comments,
	};

	// Use spawn so we can pipe the JSON payload via stdin without embedding
	// it in shell args (avoids OS argument-length limits and process listings).
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = spawn(
			"gh",
			[
				"api",
				`repos/${safeRepoRef(owner, repo)}/pulls/${prNumber}/reviews`,
				"--method",
				"POST",
				"--input",
				"-",
			],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
			} else {
				const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
				reject(new Error(stderr || `gh api exited with code ${code}`));
			}
		});

		const payloadJson = JSON.stringify(payload);
		child.stdin?.end(payloadJson, "utf-8");
	});

	let reviewUrl: string | undefined;
	try {
		const parsed = JSON.parse(stdout) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"html_url" in parsed &&
			typeof (parsed as Record<string, unknown>).html_url === "string"
		) {
			reviewUrl = (parsed as Record<string, unknown>).html_url as string;
		}
	} catch {
		// Non-JSON response — ignore, the post was still successful.
	}

	return { success: true, reviewUrl };
}

/**
 * Internal wrapper that runs `postPrReview` and returns a `PostPrReviewResult`
 * rather than throwing. This exists so callers can `await` a single expression
 * that always resolves (never rejects).
 */
async function safePostPrReview(
	...args: Parameters<typeof postPrReview>
): Promise<PostPrReviewResult> {
	try {
		return await postPrReview(...args);
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// Re-export so review-command.ts can use the safe variant if preferred.
export { safePostPrReview };
