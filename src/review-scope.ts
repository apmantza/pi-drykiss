import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangedFile, ReviewOptions } from "./types.js";
import {
	getAllSourceFiles,
	getChangedFiles,
	getFileContent,
	getFileDiff,
	getProjectIndex,
	parseDiffOutput,
	type FileContent,
	type ProjectIndexEntry,
} from "./git-diff.js";
import {
	fetchPrDiff,
	fetchPrFileContents,
	getGitRemote,
	isGhAvailable,
	parsePrUrl,
	type PrInfo,
} from "./github-pr.js";

export type ReviewMode =
	| "auto"
	| "local"
	| "staged"
	| "branch"
	| "commit"
	| "pr"
	| "full"
	| "files";

export interface ReviewScopeRequest {
	readonly mode?: ReviewMode;
	readonly files?: readonly string[];
	readonly ref?: string;
	readonly base?: string;
	readonly staged?: boolean;
	readonly all?: boolean;
	readonly commit?: string;
	readonly pr?: string | PrInfo;
}

export interface ResolveReviewScopeOptions {
	readonly contextMode?: "diff" | "full";
	readonly needsProjectIndex?: boolean;
}

export interface ReviewScope {
	readonly mode: Exclude<ReviewMode, "auto">;
	readonly label: string;
	readonly files: ChangedFile[];
	readonly diffs: Map<string, string>;
	readonly contents?: Map<string, FileContent>;
	readonly projectIndex?: ProjectIndexEntry[];
	readonly options: ReviewOptions;
	readonly metadata: Record<string, unknown>;
}

export async function resolveReviewScope(
	pi: ExtensionAPI,
	cwd: string,
	request: ReviewScopeRequest,
	options: ResolveReviewScopeOptions = {},
): Promise<ReviewScope> {
	const contextMode = options.contextMode ?? "full";
	const mode = inferMode(request);

	if (mode === "pr") {
		return resolvePrScope(cwd, request, contextMode, options.needsProjectIndex);
	}

	if (mode === "commit") {
		return resolveCommitScope(
			pi,
			cwd,
			request.commit ?? request.ref ?? "HEAD",
			contextMode,
			options.needsProjectIndex,
		);
	}

	const reviewOptions = toReviewOptions(mode, request);
	const files =
		mode === "full"
			? await getAllSourceFiles(cwd)
			: await getChangedFiles(pi, cwd, reviewOptions);
	const diffs = await gatherDiffs(pi, cwd, files, reviewOptions);
	const contents =
		contextMode !== "diff" ? await gatherContents(cwd, files) : undefined;
	const projectIndex =
		options.needsProjectIndex && contextMode !== "diff"
			? await getProjectIndex(cwd)
			: undefined;

	return {
		mode,
		label: scopeLabel(mode, reviewOptions.ref),
		files,
		diffs,
		contents,
		projectIndex,
		options: reviewOptions,
		metadata: {},
	};
}

function inferMode(request: ReviewScopeRequest): Exclude<ReviewMode, "auto"> {
	if (request.mode && request.mode !== "auto") return request.mode;
	if (request.pr) return "pr";
	if (request.all) return "full";
	if (request.staged) return "staged";
	if (request.commit) return "commit";
	if (
		(request.base ?? request.ref) &&
		(request.base ?? request.ref) !== "HEAD"
	) {
		return "branch";
	}
	if (request.files && request.files.length > 0) return "files";
	return "local";
}

function toReviewOptions(
	mode: Exclude<ReviewMode, "auto">,
	request: ReviewScopeRequest,
): ReviewOptions {
	return {
		files: request.files ?? [],
		ref: request.base ?? request.ref ?? "HEAD",
		staged: mode === "staged" || request.staged === true,
		all: mode === "full" || request.all === true,
	};
}

async function gatherDiffs(
	pi: ExtensionAPI,
	cwd: string,
	files: ChangedFile[],
	options: ReviewOptions,
): Promise<Map<string, string>> {
	const diffs = new Map<string, string>();
	for (const file of files) {
		try {
			diffs.set(file.path, await getFileDiff(pi, cwd, file.path, options));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[DRYKISS] Failed to get diff for ${file.path}:`, msg);
			diffs.set(file.path, "(diff unavailable)");
		}
	}
	return diffs;
}

async function gatherContents(
	cwd: string,
	files: ChangedFile[],
): Promise<Map<string, FileContent>> {
	const contents = new Map<string, FileContent>();
	for (const file of files) {
		const result = await getFileContent(cwd, file.path);
		if (result) contents.set(file.path, result);
	}
	return contents;
}

async function resolvePrScope(
	cwd: string,
	request: ReviewScopeRequest,
	contextMode: "diff" | "full",
	needsProjectIndex = false,
): Promise<ReviewScope> {
	if (!(await isGhAvailable())) {
		throw new Error(
			"GitHub CLI (gh) is required for PR reviews. Install it from https://cli.github.com/",
		);
	}

	let prInfo = normalizePrInfo(request.pr);
	if (!prInfo || !prInfo.owner) {
		const raw = typeof request.pr === "string" ? request.pr : "";
		const remote = await getGitRemote(cwd);
		if (remote) prInfo = parsePrUrl(raw, remote);
	}
	if (!prInfo || !prInfo.owner) {
		throw new Error(
			"Could not parse PR reference. Use a GitHub PR URL, owner/repo#123, or a PR number in a GitHub checkout.",
		);
	}

	const prDiff = await fetchPrDiff(
		cwd,
		prInfo.owner,
		prInfo.repo,
		prInfo.number,
	);
	const contents =
		contextMode !== "diff"
			? await fetchPrFileContents(
					cwd,
					prInfo.owner,
					prInfo.repo,
					prDiff.headSha,
					prDiff.files.map((f) => f.path),
				)
			: undefined;
	const projectIndex =
		needsProjectIndex && contextMode !== "diff"
			? await getProjectIndex(cwd)
			: undefined;

	return {
		mode: "pr",
		label: `${prInfo.owner}/${prInfo.repo}#${prInfo.number}`,
		files: prDiff.files,
		diffs: prDiff.diffs,
		contents,
		projectIndex,
		options: { files: [], ref: "HEAD", staged: false, all: false },
		metadata: {
			pr: prInfo,
			title: prDiff.title,
			headSha: prDiff.headSha,
		},
	};
}

function normalizePrInfo(value: ReviewScopeRequest["pr"]): PrInfo | null {
	if (!value) return null;
	if (typeof value === "string") return parsePrUrl(value);
	return value;
}

async function resolveCommitScope(
	pi: ExtensionAPI,
	cwd: string,
	commit: string,
	contextMode: "diff" | "full",
	needsProjectIndex = false,
): Promise<ReviewScope> {
	const files = await getCommitChangedFiles(pi, cwd, commit);
	const diffs = new Map<string, string>();
	for (const file of files) {
		const result = await pi.exec("git", [
			"-C",
			cwd,
			"show",
			"--format=",
			"--patch",
			"--find-renames",
			commit,
			"--",
			file.path,
		]);
		diffs.set(file.path, result.stdout || "(diff unavailable)");
	}
	const contents =
		contextMode !== "diff" ? await gatherContents(cwd, files) : undefined;
	const projectIndex =
		needsProjectIndex && contextMode !== "diff"
			? await getProjectIndex(cwd)
			: undefined;

	return {
		mode: "commit",
		label: `commit ${commit}`,
		files,
		diffs,
		contents,
		projectIndex,
		options: { files: [], ref: commit, staged: false, all: false },
		metadata: { commit },
	};
}

async function getCommitChangedFiles(
	pi: ExtensionAPI,
	cwd: string,
	commit: string,
): Promise<ChangedFile[]> {
	const result = await pi.exec("git", [
		"-C",
		cwd,
		"show",
		"--name-status",
		"--format=",
		commit,
	]);
	return parseDiffOutput(result.stdout);
}

function scopeLabel(mode: Exclude<ReviewMode, "auto">, ref: string): string {
	if (mode === "staged") return "staged changes";
	if (mode === "branch") return `branch diff against ${ref}`;
	if (mode === "full") return "full codebase";
	if (mode === "files") return "explicit files";
	return "local changes";
}
