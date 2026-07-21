import {
	readFile,
	readdir,
	stat,
	lstat,
	realpath,
	open,
} from "node:fs/promises";
import { O_NOFOLLOW } from "node:constants";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangedFile, ReviewOptions } from "./types.js";
import { LOG_PREFIX, getNodeErrorCode, assertSafeGitRef } from "./constants.js";
import { matchesAnyGlob } from "./glob-utils.js";
import { assertPathInRoot } from "./path-utils.js";
import { redactSecrets } from "./secret-redaction.js";
export { redactSecrets } from "./secret-redaction.js";
export type { RedactResult } from "./secret-redaction.js";

const STATUS_MAP: Record<string, ChangedFile["status"]> = {
	M: "modified",
	A: "added",
	R: "renamed",
	C: "copied",
	D: "deleted",
};

export function detectLanguage(p: string): string | null {
	const ext = p.split(".").pop()?.toLowerCase();
	const map: Record<string, string> = {
		ts: "TypeScript",
		tsx: "TypeScript/React",
		js: "JavaScript",
		jsx: "JavaScript/React",
		py: "Python",
		go: "Go",
		rs: "Rust",
		java: "Java",
		kt: "Kotlin",
		php: "PHP",
		rb: "Ruby",
		swift: "Swift",
		cs: "C#",
		cpp: "C++",
		c: "C",
		h: "C/C++ Header",
		scala: "Scala",
		sql: "SQL",
		html: "HTML",
		css: "CSS",
		scss: "SCSS",
		json: "JSON",
		yaml: "YAML",
		yml: "YAML",
		md: "Markdown",
		sh: "Shell",
		bash: "Shell",
		zsh: "Shell",
		dockerfile: "Dockerfile",
	};
	return map[ext ?? ""] ?? null;
}

/**
 * Parse `git diff --name-status` output.
 *
 * Git rename format: `R<score>\t<old>\t<new>`
 * Copy format:       `C<score>\t<old>\t<new>`
 * For R/C status, `parts[2]` is the current (new) path. For all other
 * statuses, `parts[1]` is the path.
 * The status code may or may not have a similarity score suffix (R vs R100).
 */
export function parseDiffOutput(stdout: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const statusCode = parts[0]?.[0];
		if (!statusCode) continue;
		const status = STATUS_MAP[statusCode];
		if (!status) continue;
		// R/C status has old\tnew; the current path is parts[2]
		const filePath =
			statusCode === "R" || statusCode === "C" ? parts[2] : parts[1];
		if (!filePath) continue;
		files.push({ path: filePath, status, language: detectLanguage(filePath) });
	}
	return files;
}

export async function getAllSourceFiles(
	cwd: string,
	ignorePatterns?: readonly string[],
): Promise<ChangedFile[]> {
	const dirsToWalk = await getSourceDirs(cwd);

	const files: ChangedFile[] = [];
	const seenPaths = new Set<string>();

	for (const dir of dirsToWalk) {
		for await (const filePath of walkDir(cwd, dir)) {
			if (seenPaths.has(filePath)) continue;
			const normalized = filePath.replaceAll(/\\/g, "/");
			if (ignorePatterns && matchesAnyGlob(normalized, ignorePatterns)) {
				continue;
			}
			seenPaths.add(filePath);
			files.push({
				path: normalized,
				status: "unchanged" as const,
				language: detectLanguage(filePath),
			});
		}
	}

	return files;
}

export async function getChangedFiles(
	pi: ExtensionAPI,
	cwd: string,
	options: ReviewOptions,
	ignorePatterns?: readonly string[],
): Promise<ChangedFile[]> {
	if (options.all) {
		return getAllSourceFiles(cwd, ignorePatterns);
	}

	if (options.files.length > 0) {
		return options.files
			.filter((fp) => !ignorePatterns || !matchesAnyGlob(fp, ignorePatterns))
			.map((fp) => ({
				path: fp,
				status: "modified" as const,
				language: detectLanguage(fp),
			}));
	}

	let diffCmd: string;
	let diffArgs: string[];

	if (options.staged) {
		diffCmd = "git";
		diffArgs = ["-C", cwd, "diff", "--cached", "--name-status"];
	} else if (options.ref !== "HEAD") {
		assertSafeGitRef(options.ref);
		diffCmd = "git";
		diffArgs = ["-C", cwd, "diff", "--name-status", `${options.ref}...HEAD`];
	} else {
		diffCmd = "git";
		diffArgs = ["-C", cwd, "diff", "--name-status", "HEAD"];
	}

	const result = await pi.exec(diffCmd, diffArgs);
	const files = parseDiffOutput(result.stdout);
	return ignorePatterns
		? files.filter((f) => !matchesAnyGlob(f.path, ignorePatterns))
		: files;
}

export async function getFileDiff(
	pi: ExtensionAPI,
	cwd: string,
	filePath: string,
	options: ReviewOptions,
): Promise<string> {
	let args: string[];
	if (options.staged) {
		args = ["-C", cwd, "diff", "--cached", "--", filePath];
	} else if (options.ref !== "HEAD") {
		assertSafeGitRef(options.ref);
		args = ["-C", cwd, "diff", `${options.ref}...HEAD`, "--", filePath];
	} else {
		args = ["-C", cwd, "diff", "HEAD", "--", filePath];
	}

	const result = await pi.exec("git", args);
	// Redact high-signal credential shapes from the patch before it
	// reaches the reviewer LLM. Defense-in-depth on top of the prompt
	// rule "never reproduce secret values" — secrets never leave the
	// local process in cleartext even if a lens forgets the instruction.
	const { text, redacted, types } = redactSecrets(result.stdout);
	if (redacted > 0) {
		console.warn(
			`${LOG_PREFIX} Redacted ${redacted} secret-like value(s) (${types.join(", ")}) from diff of ${filePath} before review.`,
		);
	}
	return text;
}

const MAX_FILE_LINES = 500;
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	"coverage",
	"vendor",
]);
const CODE_EXTS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"py",
	"go",
	"rs",
	"java",
	"kt",
	"php",
	"rb",
	"swift",
	"cs",
	"cpp",
	"c",
	"scala",
]);
const SOURCE_DIRS = ["src", "lib", "app", "packages"];

/** Detect which source directories exist in the project. */
async function getSourceDirs(cwd: string): Promise<string[]> {
	const dirsToWalk: string[] = [];
	for (const d of SOURCE_DIRS) {
		try {
			const s = await stat(assertPathInRoot(d, cwd));
			if (s.isDirectory()) dirsToWalk.push(d);
		} catch {
			// skip
		}
	}
	return dirsToWalk.length > 0 ? dirsToWalk : ["."];
}

export interface FileContent {
	readonly content: string;
	readonly lineCount: number;
	readonly truncated: boolean;
}

export async function getFileContent(
	cwd: string,
	filePath: string,
): Promise<FileContent | null> {
	// Decode URI-encoded sequences (handles %2e%2e etc.) and normalize.
	// A single decode is sufficient: the path comes from git diff output,
	// not a URL parameter. Double-encoded input stays encoded (the second
	// layer is literal text, not encoding).
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(filePath);
	} catch {
		// decodeURIComponent throws on literal '%' not followed by two hex
		// digits. Git diff output is not URL-encoded, so fall back to the
		// original path and let the resolved-path guard handle any traversal.
		decodedPath = filePath;
	}
	// Reject control characters and Windows absolute paths regardless of host
	// OS. This keeps cross-platform tests deterministic and blocks paths that
	// could bypass OS-level validation (e.g., NUL truncation, UNC shares).
	if (/[\x00-\x1f\x7f]/.test(decodedPath)) {
		console.error(
			`${LOG_PREFIX} Rejected path with control characters: ${filePath}`,
		);
		return null;
	}
	if (/^\\|^[A-Za-z]:/.test(decodedPath)) {
		console.error(`${LOG_PREFIX} Rejected Windows absolute path: ${filePath}`);
		return null;
	}
	// Resolve symlinks and verify the real path stays within cwd. This
	// prevents symlink attacks where a repo path points outside the project.
	let resolved: string;
	try {
		resolved = await realpath(assertPathInRoot(decodedPath, cwd));
		assertPathInRoot(resolved, cwd);
	} catch {
		console.error(`${LOG_PREFIX} Rejected path escaping cwd: ${filePath}`);
		return null;
	}
	try {
		// Reject non-regular files FIRST (lstat reports the actual type,
		// not the target's). This avoids hanging on FIFOs/sockets and avoids
		// opening directories. A malicious repo could plant any of these to
		// exfiltrate data, hang the review, or cause unexpected behavior.
		const linkStats = await lstat(resolved);
		if (!linkStats.isFile()) {
			console.error(`${LOG_PREFIX} Rejected non-regular file: ${filePath}`);
			return null;
		}
		// Harden against a TOCTOU swap: after realpath resolved `resolved`
		// to a canonical in-root path, an attacker could replace that file
		// with a symlink to outside cwd before we read it. Opening the
		// resolved path with O_NOFOLLOW (where supported) makes the read
		// happen through a single file descriptor, so a symlink swapped in
		// after the lstat above is caught by open (ELOOP) instead of being
		// followed out of cwd. On platforms without O_NOFOLLOW (e.g. Windows)
		// we fall back to flag 0; the realpath + assertPathInRoot guard above
		// already blocks the common "symlink points outside cwd" case.
		const noFollow = typeof O_NOFOLLOW === "number" ? O_NOFOLLOW : 0;
		const handle = await open(resolved, noFollow);
		try {
			const raw = await handle.readFile("utf8");
			// Redact BEFORE truncation so multi-line secrets (e.g. private key
			// blocks) aren't clipped at the truncation boundary and partially
			// visible. The redacted text may be shorter than the raw content,
			// but that's fine — the secret is gone.
			const redacted = redactSecrets(raw);
			if (redacted.redacted > 0) {
				console.warn(
					`${LOG_PREFIX} Redacted ${redacted.redacted} secret-like value(s) (${redacted.types.join(", ")}) from ${filePath} before review.`,
				);
			}
			const lines = redacted.text.split("\n");
			const lineCount = raw.split("\n").length;
			const truncated = lines.length > MAX_FILE_LINES;
			const content = truncated
				? lines.slice(0, MAX_FILE_LINES).join("\n") +
					"\n\n... (truncated: " +
					(lineCount - MAX_FILE_LINES) +
					" more lines) ...\n"
				: redacted.text;
			return { content, lineCount, truncated };
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch (err) {
		const code = getNodeErrorCode(err);
		// ELOOP: a symlink was swapped in at the resolved path after the
		// lstat above. Treat it like any other non-regular file.
		if (code === "ELOOP") {
			console.error(
				`${LOG_PREFIX} Rejected symlink at resolved path: ${filePath}`,
			);
			return null;
		}
		// ENOENT is expected for missing files (e.g., deleted files in git status)
		if (code === "ENOENT") {
			return null;
		}
		// Permission errors — warn the user but continue
		if (code === "EACCES" || code === "EPERM") {
			console.warn(
				`${LOG_PREFIX} Permission denied reading ${filePath}, skipping.`,
			);
			return null;
		}
		// Unexpected errors — rethrow so callers know something is wrong
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read ${filePath}: ${msg}`);
	}
}

export interface ProjectIndexEntry {
	readonly path: string;
	readonly exports: readonly string[];
}

async function* walkDir(cwd: string, dir: string): AsyncGenerator<string> {
	let entries: import("fs").Dirent[];
	try {
		entries = await readdir(assertPathInRoot(dir, cwd), {
			withFileTypes: true,
		});
	} catch (err) {
		// Skip unreadable directories to avoid blocking the entire file scan
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`${LOG_PREFIX} Skipping unreadable directory ${dir}: ${msg}`);
		return;
	}
	for (const entry of entries) {
		// Skip symlinks at the directory AND file level — readdir's
		// Dirent.isFile()/isDirectory() follow symlinks, so a symlink to
		// /etc/passwd would otherwise be read by getProjectIndex and its
		// contents (or its recursive contents, for symlink-to-dir) shipped
		// to the LLM. We never recurse into a symlinked subtree.
		if (entry.isSymbolicLink()) continue;
		const childPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
		assertPathInRoot(childPath, cwd);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* walkDir(cwd, childPath);
		} else if (entry.isFile()) {
			const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
			if (CODE_EXTS.has(ext)) {
				yield childPath;
			}
		}
	}
}

function extractExports(content: string, ext: string): string[] {
	const exports: string[] = [];
	const seen = new Set<string>();

	// TypeScript/JavaScript: export function/class/const/interface/type/enum name
	// Handles optional 'default', 'async', and generator (*) keywords.
	const declRe =
		/export\s+(?:default\s+)?(?:async\s+)?(?:function\s+(?:\*\s*)?|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)(\w+)/g;
	let m: RegExpExecArray | null;
	while ((m = declRe.exec(content)) !== null) {
		if (!seen.has(m[1])) {
			seen.add(m[1]);
			exports.push(m[1]);
		}
	}

	// Named exports: export { foo, bar }
	const namedRe = /export\s+\{([^}]+)\}/g;
	while ((m = namedRe.exec(content)) !== null) {
		for (const name of m[1].split(",")) {
			const clean = name
				.trim()
				.split(/\s+as\s+/)[0]
				.trim();
			if (clean && !seen.has(clean)) {
				seen.add(clean);
				exports.push(clean);
			}
		}
	}

	// Python: def/class name
	if (ext === "py") {
		const pyRe = /^(?:def|class)\s+(\w+)/gm;
		while ((m = pyRe.exec(content)) !== null) {
			if (!seen.has(m[1])) {
				seen.add(m[1]);
				exports.push(m[1]);
			}
		}
	}

	// Go: func Name
	if (ext === "go") {
		const goRe = /^func\s+(?:\([^)]+\)\s+)?(\w+)/gm;
		while ((m = goRe.exec(content)) !== null) {
			if (!seen.has(m[1])) {
				seen.add(m[1]);
				exports.push(m[1]);
			}
		}
	}

	// Rust: pub fn/struct/enum/trait/const/static/type name
	if (ext === "rs") {
		const rsRe = /pub\s+(?:fn|struct|enum|trait|const|static|type)\s+(\w+)/g;
		while ((m = rsRe.exec(content)) !== null) {
			if (!seen.has(m[1])) {
				seen.add(m[1]);
				exports.push(m[1]);
			}
		}
	}

	return exports;
}

async function* projectIndexCandidates(
	cwd: string,
	paths?: readonly string[],
): AsyncGenerator<string> {
	if (paths && paths.length > 0) {
		for (const p of paths) yield p;
		return;
	}

	const dirsToWalk = await getSourceDirs(cwd);
	const seenPaths = new Set<string>();
	for (const dir of dirsToWalk) {
		for await (const filePath of walkDir(cwd, dir)) {
			if (seenPaths.has(filePath)) continue;
			seenPaths.add(filePath);
			yield filePath;
		}
	}
}

/** Run up to `limit` async tasks concurrently and return results in order. */
async function withConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	limit: number,
): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < tasks.length) {
			const idx = next++;
			results[idx] = await tasks[idx]();
		}
	}
	const workers: Promise<void>[] = [];
	for (let i = 0; i < Math.min(limit, tasks.length); i++) {
		workers.push(worker());
	}
	await Promise.all(workers);
	return results;
}

export async function getProjectIndex(
	cwd: string,
	maxFiles = 200,
	paths?: readonly string[],
	ignorePatterns?: readonly string[],
): Promise<ProjectIndexEntry[]> {
	// Phase 1: collect candidate paths (preserving dedup + filter logic).
	const candidates: string[] = [];
	const seenPaths = new Set<string>();

	for await (const filePath of projectIndexCandidates(cwd, paths)) {
		const normalized = filePath.replaceAll(/\\/g, "/");
		if (seenPaths.has(normalized)) continue;
		seenPaths.add(normalized);
		if (ignorePatterns && matchesAnyGlob(normalized, ignorePatterns)) continue;
		candidates.push(normalized);
		if (candidates.length >= maxFiles) break;
	}

	// Phase 2: read files in parallel with a concurrency cap of 8.
	const CONCURRENCY = 8;
	type ReadResult = { normalized: string; raw: string } | { normalized: string; err: unknown };

	const tasks = candidates.map(
		(normalized) => async (): Promise<ReadResult> => {
			try {
				const raw = await readFile(assertPathInRoot(normalized, cwd), "utf8");
				return { normalized, raw };
			} catch (err) {
				return { normalized, err };
			}
		},
	);

	const results = await withConcurrency(tasks, CONCURRENCY);

	// Phase 3: extract exports from successful reads, warn on failures.
	const entries: ProjectIndexEntry[] = [];
	for (const result of results) {
		if ("err" in result) {
			const { normalized, err } = result;
			const code = getNodeErrorCode(err);
			if (code === "EACCES" || code === "EPERM") {
				console.warn(`${LOG_PREFIX} Skipping ${normalized}: permission denied`);
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`${LOG_PREFIX} Skipping ${normalized}: ${msg}`);
			}
			continue;
		}
		const { normalized, raw } = result;
		const ext = normalized.split(".").pop()?.toLowerCase() ?? "";
		const exports = extractExports(raw, ext);
		if (exports.length > 0) {
			entries.push({ path: normalized, exports });
		}
	}

	return entries;
}
