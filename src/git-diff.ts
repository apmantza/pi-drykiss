import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangedFile, ReviewOptions } from "./types.js";

const STATUS_MAP: Record<string, ChangedFile["status"]> = {
	M: "modified",
	A: "added",
	R: "renamed",
	C: "copied",
	D: "deleted",
};

export function detectLanguage(path: string): string | null {
	const ext = path.split(".").pop()?.toLowerCase();
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

function parseDiffOutput(stdout: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const statusCode = parts[0]?.[0];
		if (!statusCode) continue;
		const status = STATUS_MAP[statusCode];
		if (!status) continue;
		const path = parts[1];
		if (!path) continue;
		files.push({ path, status, language: detectLanguage(path) });
	}
	return files;
}

export async function getAllSourceFiles(cwd: string): Promise<ChangedFile[]> {
	const sourceDirs = ["src", "lib", "app", "packages"];
	const dirsToWalk: string[] = [];
	for (const d of sourceDirs) {
		try {
			const s = await stat(join(cwd, d));
			if (s.isDirectory()) dirsToWalk.push(d);
		} catch {
			// skip
		}
	}
	if (dirsToWalk.length === 0) dirsToWalk.push(".");

	const files: ChangedFile[] = [];
	const seenPaths = new Set<string>();

	for (const dir of dirsToWalk) {
		for await (const filePath of walkDir(cwd, dir)) {
			if (seenPaths.has(filePath)) continue;
			seenPaths.add(filePath);
			files.push({
				path: filePath.replace(/\\/g, "/"),
				status: "modified" as const,
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
): Promise<ChangedFile[]> {
	if (options.all) {
		return getAllSourceFiles(cwd);
	}

	if (options.files.length > 0) {
		return options.files.map((path) => ({
			path,
			status: "modified" as const,
			language: detectLanguage(path),
		}));
	}

	let diffCmd: string;
	let diffArgs: string[];

	if (options.staged) {
		diffCmd = "git";
		diffArgs = ["-C", cwd, "diff", "--cached", "--name-status"];
	} else if (options.ref !== "HEAD") {
		diffCmd = "git";
		diffArgs = ["-C", cwd, "diff", "--name-status", `${options.ref}...HEAD`];
	} else {
		diffCmd = "git";
		diffArgs = ["-C", cwd, "diff", "--name-status", "HEAD"];
	}

	const result = await pi.exec(diffCmd, diffArgs);
	return parseDiffOutput(result.stdout);
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

export interface FileContent {
	readonly content: string;
	readonly lineCount: number;
	readonly truncated: boolean;
}

export async function getFileContent(
	cwd: string,
	filePath: string,
): Promise<FileContent | null> {
	// Prevent path traversal: reject absolute paths
	if (filePath.startsWith("/") || filePath.startsWith("\\")) {
		console.error(`[DRYKISS] Rejected absolute path: ${filePath}`);
		return null;
	}
	// Reject paths that escape the cwd
	if (filePath.includes("..") || filePath.includes("~")) {
		console.error(`[DRYKISS] Rejected suspicious path: ${filePath}`);
		return null;
	}
	try {
		const raw = await readFile(join(cwd, filePath), "utf8");
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
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[DRYKISS] Failed to read ${filePath}:`, msg);
		return null;
	}
}

export interface ProjectIndexEntry {
	readonly path: string;
	readonly exports: readonly string[];
}

async function* walkDir(cwd: string, dir: string): AsyncGenerator<string> {
	const entries = await readdir(join(cwd, dir), { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* walkDir(cwd, join(dir, entry.name));
		} else if (entry.isFile()) {
			const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
			if (CODE_EXTS.has(ext)) {
				yield join(dir, entry.name);
			}
		}
	}
}

function extractExports(content: string, ext: string): string[] {
	const exports: string[] = [];
	const seen = new Set<string>();

	// TypeScript/JavaScript: export function/class/const/interface/type/enum name
	const declRe =
		/export\s+(?:default\s+)?(?:function\s+(?:\*\s*)?|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)(\w+)/g;
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

export async function getProjectIndex(
	cwd: string,
	maxFiles = 200,
): Promise<ProjectIndexEntry[]> {
	const sourceDirs = ["src", "lib", "app", "packages"];
	const dirsToWalk: string[] = [];
	for (const d of sourceDirs) {
		try {
			const s = await stat(join(cwd, d));
			if (s.isDirectory()) dirsToWalk.push(d);
		} catch {
			// skip
		}
	}
	if (dirsToWalk.length === 0) dirsToWalk.push(".");

	const entries: ProjectIndexEntry[] = [];
	const seenPaths = new Set<string>();

	for (const dir of dirsToWalk) {
		for await (const filePath of walkDir(cwd, dir)) {
			if (seenPaths.has(filePath)) continue;
			seenPaths.add(filePath);
			if (entries.length >= maxFiles) break;

			try {
				const raw = await readFile(join(cwd, filePath), "utf8");
				const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
				const exports = extractExports(raw, ext);
				if (exports.length > 0) {
					entries.push({ path: filePath.replace(/\\/g, "/"), exports });
				}
			} catch {
				// skip unreadable
			}
		}
		if (entries.length >= maxFiles) break;
	}

	return entries;
}
