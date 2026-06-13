import { readFile, readdir, stat, lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangedFile, ReviewOptions } from "./types.js";
import { LOG_PREFIX, getNodeErrorCode, assertSafeGitRef } from "./constants.js";
import { matchesAnyGlob } from "./glob-utils.js";
import { assertPathInRoot } from "./path-utils.js";

export const STATUS_MAP: Record<string, ChangedFile["status"]> = {
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
			const normalized = filePath.replace(/\\/g, "/");
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
	return result.stdout;
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
			const s = await stat(path.join(cwd, d));
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
		// Reject non-regular files: symlinks (readFile follows them),
		// FIFOs (readFile hangs indefinitely), sockets, and device files.
		// A malicious repo could plant any of these to exfiltrate data,
		// hang the review, or cause unexpected behavior. lstat reports
		// the actual type (not the target's type), so this is safe.
		const linkStats = await lstat(resolved);
		if (!linkStats.isFile()) {
			console.error(`${LOG_PREFIX} Rejected non-regular file: ${filePath}`);
			return null;
		}
		const raw = await readFile(resolved, "utf8");
		const lines = raw.split("\n");
		const truncated = lines.length > MAX_FILE_LINES;
		const content = truncated
			? lines.slice(0, MAX_FILE_LINES).join("\n") +
				"\n\n... (truncated: " +
				(lines.length - MAX_FILE_LINES) +
				" more lines) ...\n"
			: raw;
		return { content, lineCount: lines.length, truncated };
	} catch (err) {
		const code = getNodeErrorCode(err);
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
		entries = await readdir(path.join(cwd, dir), { withFileTypes: true });
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
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* walkDir(cwd, path.join(dir, entry.name));
		} else if (entry.isFile()) {
			const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
			if (CODE_EXTS.has(ext)) {
				yield path.join(dir, entry.name);
			}
		}
	}
}

function extractExports(content: string, ext: string): string[] {
	const exports: string[] = [];
	const seen = new Set<string>();

	// TypeScript/JavaScript: export function/class/const/interface/type/enum name
	// Handles optional 'async' keyword before function declarations
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

export async function getProjectIndex(
	cwd: string,
	maxFiles = 200,
	paths?: readonly string[],
	ignorePatterns?: readonly string[],
): Promise<ProjectIndexEntry[]> {
	const entries: ProjectIndexEntry[] = [];
	const seenPaths = new Set<string>();

	for await (const filePath of projectIndexCandidates(cwd, paths)) {
		const normalized = filePath.replace(/\\/g, "/");
		if (seenPaths.has(normalized)) continue;
		seenPaths.add(normalized);
		if (ignorePatterns && matchesAnyGlob(normalized, ignorePatterns)) continue;
		if (entries.length >= maxFiles) break;

		try {
			const raw = await readFile(path.join(cwd, normalized), "utf8");
			const ext = normalized.split(".").pop()?.toLowerCase() ?? "";
			const exports = extractExports(raw, ext);
			if (exports.length > 0) {
				entries.push({ path: normalized, exports });
			}
		} catch (err) {
			// skip unreadable files with a warning so the index is not silently incomplete
			const code = getNodeErrorCode(err);
			if (code === "EACCES" || code === "EPERM") {
				console.warn(`${LOG_PREFIX} Skipping ${normalized}: permission denied`);
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`${LOG_PREFIX} Skipping ${normalized}: ${msg}`);
			}
		}
	}

	return entries;
}
