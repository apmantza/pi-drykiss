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
import { applyScoutResult, runScout, type ScoutStatus } from "./scout.js";
import { assertSafeGitRef } from "./constants.js";
import { logAutoreviewEvent } from "./logger.js";
import { matchesAnyGlob } from "./glob-utils.js";
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

interface ReviewScopeRequest {
	readonly mode?: ReviewMode;
	readonly files?: readonly string[];
	readonly ref?: string;
	readonly base?: string;
	readonly staged?: boolean;
	readonly all?: boolean;
	readonly commit?: string;
	readonly pr?: string | PrInfo;
}

interface ResolveReviewScopeOptions {
	readonly contextMode?: "diff" | "full";
	readonly needsProjectIndex?: boolean;
	/** Glob patterns for files to exclude from the review scope. */
	readonly ignorePatterns?: readonly string[];
	/** Policy filters applied after scope discovery; force-includes win. */
	readonly pathFilters?: {
		readonly exclude?: readonly string[];
		readonly forceInclude?: readonly string[];
	};
	/** Optional progress callback for per-file scope preparation. */
	readonly onFileProgress?: (
		completed: number,
		total: number,
		label: string,
	) => void;
	/**
	 * Scout pre-flight configuration. When `enabled` is true and the review
	 * mode is "full", the scout runs first to map the project and select
	 * the most important files for the review lenses.
	 */
	scout?: {
		readonly enabled?: boolean;
		readonly maxFiles?: number;
		readonly docs?: readonly string[];
	};
	/** Effective project model hint for the scout LLM call. */
	readonly scoutModelHint?: string;
	/** Correlates scout lifecycle events with the enclosing autoreview. */
	readonly correlationId?: string;
	/** Receives the scout outcome for progress and final-result reporting. */
	readonly onScoutStatus?: (status: ScoutStatus) => void;
	/**
	 * Abort signal that can cancel the scout stage and scope preparation.
	 */
	signal?: AbortSignal;
}

export interface ReviewScope {
	readonly mode: Exclude<ReviewMode, "auto">;
	readonly label: string;
	readonly files: ChangedFile[];
	readonly diffs: Map<string, string>;
	readonly contents?: Map<string, FileContent>;
	readonly projectIndex?: ProjectIndexEntry[];
	/** Scope-preparation failures that made the review context incomplete. */
	readonly preparationErrors: readonly string[];
	readonly options: ReviewOptions;
	readonly metadata: Record<string, unknown>;
}

interface CollectionResult<T> {
	readonly value: T;
	readonly errors: string[];
}

export async function resolveReviewScope(
	pi: ExtensionAPI,
	cwd: string,
	request: ReviewScopeRequest,
	options: ResolveReviewScopeOptions = {},
	ctx?: import("@earendil-works/pi-coding-agent").ExtensionContext,
): Promise<ReviewScope> {
	const contextMode = options.contextMode ?? "full";
	const mode = inferMode(request);
	logAutoreviewEvent("scope.start", {
		cwd,
		mode,
		contextMode,
		scoutEnabled: options.scout?.enabled === true,
	});

	if (mode === "pr") {
		const scope = await resolvePrScope(
			cwd,
			request,
			contextMode,
			options.needsProjectIndex,
			options.ignorePatterns,
		);
		return filterResolvedScope(scope, options.pathFilters);
	}

	if (mode === "commit") {
		const scope = await resolveCommitScope(
			pi,
			cwd,
			request.commit ?? request.ref ?? "HEAD",
			contextMode,
			options.needsProjectIndex,
			options.ignorePatterns,
		);
		return filterResolvedScope(scope, options.pathFilters);
	}

	const reviewOptions = toReviewOptions(mode, request);
	const scoutMetadata: Record<string, unknown> = {
		enabled: mode === "full" && options.scout?.enabled === true,
	};
	let discoveredFiles: ChangedFile[];
	if (mode === "full" && options.scout?.enabled) {
		if (!ctx) {
			scoutMetadata.phase = "fallback";
			scoutMetadata.reason = "No ExtensionContext available";
			options.onScoutStatus?.({
				phase: "fallback",
				reason: "No ExtensionContext available",
			});
			discoveredFiles = await getAllSourceFiles(cwd, options.ignorePatterns);
		} else {
			const allFiles = await getAllSourceFiles(cwd, options.ignorePatterns);
			const scoutResult = await runScout(ctx, {
				cwd,
				allFiles,
				maxFiles: options.scout.maxFiles,
				docs: options.scout.docs,
				ignorePatterns: options.ignorePatterns,
				modelHint: options.scoutModelHint,
				correlationId: options.correlationId,
				signal: options.signal,
				onStatus: (status) => {
					Object.assign(scoutMetadata, status);
					logAutoreviewEvent("scout.status", {
						correlationId: options.correlationId,
						...status,
					});
					options.onScoutStatus?.(status);
				},
			});
			discoveredFiles = scoutResult
				? applyScoutResult(allFiles, scoutResult)
				: allFiles;
		}
	} else {
		discoveredFiles =
			mode === "full"
				? await getAllSourceFiles(cwd, options.ignorePatterns)
				: await getChangedFiles(pi, cwd, reviewOptions, options.ignorePatterns);
	}
	const files = applyPathFilters(
		discoveredFiles,
		options.pathFilters,
		mode === "files",
	);
	const diffCollection = await gatherDiffs(
		pi,
		cwd,
		files,
		reviewOptions,
		options.onFileProgress,
	);
	const contentCollection =
		contextMode !== "diff"
			? await gatherContents(cwd, files, options.onFileProgress)
			: undefined;
	const projectIndex =
		options.needsProjectIndex && contextMode !== "diff"
			? await getProjectIndex(
					cwd,
					200,
					mode === "full" ? files.map((f) => f.path) : undefined,
					options.ignorePatterns,
				)
			: undefined;

	const scope = {
		mode,
		label: scopeLabel(mode, reviewOptions.ref),
		files,
		diffs: diffCollection.value,
		contents: contentCollection?.value,
		projectIndex,
		preparationErrors: [
			...diffCollection.errors,
			...(contentCollection?.errors ?? []),
		],
		options: reviewOptions,
		metadata: scoutMetadata,
	};
	logAutoreviewEvent("scope.complete", {
		mode: scope.mode,
		files: scope.files.length,
		preparationErrors: scope.preparationErrors.length,
		scoutEnabled: scope.metadata.enabled === true,
		scoutStatus: scope.metadata.phase ?? scope.metadata.status,
		scoutReason: scope.metadata.reason,
	});
	return scope;
}

function filterResolvedScope(
	scope: ReviewScope,
	filters: ResolveReviewScopeOptions["pathFilters"],
): ReviewScope {
	const files = applyPathFilters(scope.files, filters, false);
	if (files.length === scope.files.length) return scope;
	const kept = new Set(files.map((file) => file.path));
	return {
		...scope,
		files,
		diffs: new Map([...scope.diffs].filter(([path]) => kept.has(path))),
		...(scope.contents
			? {
					contents: new Map(
						[...scope.contents].filter(([path]) => kept.has(path)),
					),
				}
			: {}),
		...(scope.projectIndex
			? {
					projectIndex: scope.projectIndex.filter((entry) =>
						kept.has(entry.path),
					),
				}
			: {}),
	};
}

function applyPathFilters(
	files: readonly ChangedFile[],
	filters: ResolveReviewScopeOptions["pathFilters"],
	explicitFiles: boolean,
): ChangedFile[] {
	if (!filters?.exclude || filters.exclude.length === 0 || explicitFiles) {
		return [...files];
	}
	return files.filter(
		(file) =>
			matchesAnyGlob(file.path, filters.forceInclude ?? []) ||
			!matchesAnyGlob(file.path, filters.exclude ?? []),
	);
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

/**
 * Runs `tasks` with at most `limit` concurrent executions at a time.
 * Each task is a zero-argument async factory; results are returned in the
 * same order as the input array.
 */
async function withConcurrencyLimit<T>(
	tasks: (() => Promise<T>)[],
	limit: number,
): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < tasks.length) {
			const i = nextIndex++;
			results[i] = await tasks[i]();
		}
	}

	const workers = Array.from(
		{ length: Math.min(limit, tasks.length) },
		() => worker(),
	);
	await Promise.all(workers);
	return results;
}

const GATHER_CONCURRENCY = 8;

async function gatherDiffs(
	pi: ExtensionAPI,
	cwd: string,
	files: ChangedFile[],
	options: ReviewOptions,
	onProgress?: (completed: number, total: number, label: string) => void,
): Promise<CollectionResult<Map<string, string>>> {
	const diffs = new Map<string, string>();
	const errors: string[] = [];
	let completed = 0;

	const tasks = files.map((file) => async () => {
		try {
			diffs.set(file.path, await getFileDiff(pi, cwd, file.path, options));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`Failed to get diff for ${file.path}: ${msg}`);
			diffs.set(file.path, "(diff unavailable)");
		} finally {
			completed += 1;
			onProgress?.(completed, files.length, "Preparing diffs");
		}
	});

	await withConcurrencyLimit(tasks, GATHER_CONCURRENCY);
	return { value: diffs, errors };
}

async function gatherContents(
	cwd: string,
	files: ChangedFile[],
	onProgress?: (completed: number, total: number, label: string) => void,
): Promise<CollectionResult<Map<string, FileContent>>> {
	const contents = new Map<string, FileContent>();
	const errors: string[] = [];
	let completed = 0;

	const tasks = files.map((file) => async () => {
		try {
			const result = await getFileContent(cwd, file.path);
			if (result) contents.set(file.path, result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`Failed to load content for ${file.path}: ${msg}`);
		} finally {
			completed += 1;
			onProgress?.(completed, files.length, "Loading file contents");
		}
	});

	await withConcurrencyLimit(tasks, GATHER_CONCURRENCY);
	return { value: contents, errors };
}

async function resolvePrScope(
	cwd: string,
	request: ReviewScopeRequest,
	contextMode: "diff" | "full",
	needsProjectIndex = false,
	ignorePatterns?: readonly string[],
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
	const filteredFiles = ignorePatterns
		? prDiff.files.filter((f) => !matchesAnyGlob(f.path, ignorePatterns))
		: prDiff.files;
	const filteredDiffs = new Map<string, string>();
	for (const f of filteredFiles) {
		const d = prDiff.diffs.get(f.path);
		if (d !== undefined) filteredDiffs.set(f.path, d);
	}
	const contents =
		contextMode !== "diff"
			? await fetchPrFileContents(
					cwd,
					prInfo.owner,
					prInfo.repo,
					prDiff.headSha,
					filteredFiles.map((f) => f.path),
				)
			: undefined;
	const projectIndex =
		needsProjectIndex && contextMode !== "diff"
			? await getProjectIndex(cwd, 200, undefined, ignorePatterns)
			: undefined;

	return {
		mode: "pr",
		label: `${prInfo.owner}/${prInfo.repo}#${prInfo.number}`,
		files: filteredFiles,
		diffs: filteredDiffs,
		contents,
		projectIndex,
		preparationErrors: [],
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
	ignorePatterns?: readonly string[],
): Promise<ReviewScope> {
	assertSafeGitRef(commit);
	let files = await getCommitChangedFiles(pi, cwd, commit);
	if (ignorePatterns) {
		files = files.filter((f) => !matchesAnyGlob(f.path, ignorePatterns));
	}
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
	const contentCollection =
		contextMode !== "diff" ? await gatherContents(cwd, files) : undefined;
	const projectIndex =
		needsProjectIndex && contextMode !== "diff"
			? await getProjectIndex(cwd, 200, undefined, ignorePatterns)
			: undefined;

	return {
		mode: "commit",
		label: `commit ${commit}`,
		files,
		diffs,
		contents: contentCollection?.value,
		projectIndex,
		preparationErrors: contentCollection?.errors ?? [],
		options: { files: [], ref: commit, staged: false, all: false },
		metadata: { commit },
	};
}

async function getCommitChangedFiles(
	pi: ExtensionAPI,
	cwd: string,
	commit: string,
): Promise<ChangedFile[]> {
	assertSafeGitRef(commit);
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
