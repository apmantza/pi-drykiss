import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type BenchSeverity = "critical" | "high" | "medium" | "low" | "nit";
export type MaterialityExpectation = "must-find" | "should-find" | "clean";

export interface FindingMatcher {
	readonly path?: string;
	readonly lineStart?: number;
	readonly lineEnd?: number;
	readonly riskCode?: string;
	readonly minSeverity?: BenchSeverity;
	readonly summaryIncludes?: string;
}

export interface ReviewBenchManifest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly title: string;
	readonly diffFile: string;
	readonly contextFile?: string;
	readonly scopePaths: readonly string[];
	readonly expectedFindings: readonly FindingMatcher[];
	readonly allowedNonFindings: readonly FindingMatcher[];
	readonly knownFalsePositiveTraps: readonly string[];
	readonly materiality: MaterialityExpectation;
}

export interface ReviewBenchFixture {
	readonly directory: string;
	readonly manifest: ReviewBenchManifest;
	readonly diff: string;
	readonly context?: string;
}

export interface BenchFinding {
	readonly file: string;
	readonly line?: number;
	readonly severity: BenchSeverity;
	readonly riskCode?: string;
	readonly summary: string;
}

export interface ReviewBenchRun {
	readonly fixtureId: string;
	readonly findings: readonly BenchFinding[];
	readonly invalidFindingCount?: number;
	readonly calls?: number;
	readonly estimatedTokens?: number;
	readonly elapsedMs?: number;
}

export interface ReviewBenchScore {
	readonly fixtureId: string;
	readonly materiality: MaterialityExpectation;
	readonly expectedFindingCount: number;
	readonly matchedExpectedCount: number;
	readonly missedExpectedFindings: readonly FindingMatcher[];
	readonly falsePositiveCount: number;
	readonly invalidFindingCount: number;
	readonly outOfScopeFindingCount: number;
	readonly duplicateCount: number;
	readonly usefulnessRate: number;
	readonly signalToNoiseRatio: number;
	readonly calls?: number;
	readonly estimatedTokens?: number;
	readonly elapsedMs?: number;
}

export interface ReviewBenchSummary {
	readonly fixtureCount: number;
	readonly seededDefectHitRate: number;
	readonly falsePositiveCount: number;
	readonly invalidFindingCount: number;
	readonly outOfScopeFindingCount: number;
	readonly duplicateCount: number;
	readonly usefulnessRate: number;
	readonly signalToNoiseRatio: number;
	readonly calls: number;
	readonly estimatedTokens: number;
	readonly elapsedMs: number;
}

const SEVERITY_RANK: Record<BenchSeverity, number> = {
	nit: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

/** Load versioned, data-only review-benchmark fixtures from disk. */
export async function loadReviewBenchFixtures(
	root: string,
): Promise<ReviewBenchFixture[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const directories: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) directories.push(join(root, entry.name));
	}
	const fixtures = await Promise.all(directories.map(loadReviewBenchFixture));
	return fixtures.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export async function loadReviewBenchFixture(
	directory: string,
): Promise<ReviewBenchFixture> {
	const manifestPath = join(directory, "manifest.json");
	let rawManifest: unknown;
	try {
		rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not parse ${manifestPath}: ${message}`);
	}
	const manifest = parseReviewBenchManifest(rawManifest, manifestPath);
	const [diff, context] = await Promise.all([
		readFixtureFile(directory, manifest.diffFile, "diffFile"),
		manifest.contextFile
			? readFixtureFile(directory, manifest.contextFile, "contextFile")
			: Promise.resolve(undefined),
	]);
	return { directory, manifest, diff, ...(context ? { context } : {}) };
}

export function parseReviewBenchManifest(
	value: unknown,
	source = "manifest",
): ReviewBenchManifest {
	if (!isPlainRecord(value)) throw new Error(`${source} must be a JSON object`);
	if (value.schemaVersion !== 1) {
		throw new Error(`${source}.schemaVersion must be 1`);
	}
	const id = requiredString(value.id, `${source}.id`);
	const title = requiredString(value.title, `${source}.title`);
	const diffFile = fixtureFileName(value.diffFile, `${source}.diffFile`);
	const contextFile =
		value.contextFile === undefined
			? undefined
			: fixtureFileName(value.contextFile, `${source}.contextFile`);
	const scopePaths = stringArray(value.scopePaths, `${source}.scopePaths`).map(
		normalizePath,
	);
	if (scopePaths.length === 0) {
		throw new Error(`${source}.scopePaths must contain at least one path`);
	}
	const expectedFindings = matcherArray(
		value.expectedFindings,
		`${source}.expectedFindings`,
	);
	const allowedNonFindings = matcherArray(
		value.allowedNonFindings,
		`${source}.allowedNonFindings`,
	);
	const knownFalsePositiveTraps = stringArray(
		value.knownFalsePositiveTraps,
		`${source}.knownFalsePositiveTraps`,
	);
	if (!isMaterialityExpectation(value.materiality)) {
		throw new Error(`${source}.materiality is invalid`);
	}
	if (value.materiality === "clean" && expectedFindings.length > 0) {
		throw new Error(`${source} clean fixtures cannot require findings`);
	}
	return {
		schemaVersion: 1,
		id,
		title,
		diffFile,
		...(contextFile ? { contextFile } : {}),
		scopePaths,
		expectedFindings,
		allowedNonFindings,
		knownFalsePositiveTraps,
		materiality: value.materiality,
	};
}

/** Parse a recorded, data-only run artifact without invoking a model. */
export function parseReviewBenchRun(
	value: unknown,
	source = "run",
): ReviewBenchRun {
	if (!isPlainRecord(value)) throw new Error(`${source} must be an object`);
	const fixtureId = requiredString(value.fixtureId, `${source}.fixtureId`);
	if (!Array.isArray(value.findings)) {
		throw new Error(`${source}.findings must be an array`);
	}
	const invalidFindingCount = optionalNonNegativeNumber(
		value.invalidFindingCount,
		`${source}.invalidFindingCount`,
	);
	const calls = optionalNonNegativeNumber(value.calls, `${source}.calls`);
	const estimatedTokens = optionalNonNegativeNumber(
		value.estimatedTokens,
		`${source}.estimatedTokens`,
	);
	const elapsedMs = optionalNonNegativeNumber(
		value.elapsedMs,
		`${source}.elapsedMs`,
	);
	return {
		fixtureId,
		findings: value.findings.map((finding, index) =>
			parseBenchFinding(finding, `${source}.findings[${index}]`),
		),
		...(invalidFindingCount === undefined ? {} : { invalidFindingCount }),
		...(calls === undefined ? {} : { calls }),
		...(estimatedTokens === undefined ? {} : { estimatedTokens }),
		...(elapsedMs === undefined ? {} : { elapsedMs }),
	};
}

/** Score one recorded review run without calling an LLM. */
export function scoreReviewBenchRun(
	fixture: ReviewBenchFixture,
	run: ReviewBenchRun,
): ReviewBenchScore {
	if (run.fixtureId !== fixture.manifest.id) {
		throw new Error(
			`Run fixtureId ${run.fixtureId} does not match ${fixture.manifest.id}`,
		);
	}
	const matchedExpected = fixture.manifest.expectedFindings.filter((matcher) =>
		run.findings.some((finding) => matchesFinding(finding, matcher)),
	);
	const missedExpectedFindings = fixture.manifest.expectedFindings.filter(
		(matcher) => !matchedExpected.includes(matcher),
	);
	const duplicateCount = countDuplicateFindings(run.findings);
	const outOfScopeFindingCount = run.findings.filter(
		(finding) =>
			!fixture.manifest.scopePaths.includes(normalizePath(finding.file)),
	).length;
	const falsePositiveCount = run.findings.filter(
		(finding) =>
			!fixture.manifest.expectedFindings.some((matcher) =>
				matchesFinding(finding, matcher),
			) &&
			!fixture.manifest.allowedNonFindings.some((matcher) =>
				matchesFinding(finding, matcher),
			),
	).length;
	const uniqueFindingCount = Math.max(0, run.findings.length - duplicateCount);
	let usefulnessRate = 0;
	if (uniqueFindingCount === 0) {
		usefulnessRate = fixture.manifest.materiality === "clean" ? 1 : 0;
	} else {
		usefulnessRate = matchedExpected.length / uniqueFindingCount;
	}
	return {
		fixtureId: fixture.manifest.id,
		materiality: fixture.manifest.materiality,
		expectedFindingCount: fixture.manifest.expectedFindings.length,
		matchedExpectedCount: matchedExpected.length,
		missedExpectedFindings,
		falsePositiveCount,
		invalidFindingCount: run.invalidFindingCount ?? 0,
		outOfScopeFindingCount,
		duplicateCount,
		usefulnessRate,
		signalToNoiseRatio:
			matchedExpected.length / Math.max(1, falsePositiveCount),
		...(run.calls === undefined ? {} : { calls: run.calls }),
		...(run.estimatedTokens === undefined
			? {}
			: { estimatedTokens: run.estimatedTokens }),
		...(run.elapsedMs === undefined ? {} : { elapsedMs: run.elapsedMs }),
	};
}

export function summarizeReviewBenchScores(
	scores: readonly ReviewBenchScore[],
): ReviewBenchSummary {
	const totals = scores.reduce(
		(total, score) => ({
			expected: total.expected + score.expectedFindingCount,
			matched: total.matched + score.matchedExpectedCount,
			falsePositives: total.falsePositives + score.falsePositiveCount,
			invalid: total.invalid + score.invalidFindingCount,
			outOfScope: total.outOfScope + score.outOfScopeFindingCount,
			duplicates: total.duplicates + score.duplicateCount,
			usefulness: total.usefulness + score.usefulnessRate,
			calls: total.calls + (score.calls ?? 0),
			tokens: total.tokens + (score.estimatedTokens ?? 0),
			elapsed: total.elapsed + (score.elapsedMs ?? 0),
		}),
		{
			expected: 0,
			matched: 0,
			falsePositives: 0,
			invalid: 0,
			outOfScope: 0,
			duplicates: 0,
			usefulness: 0,
			calls: 0,
			tokens: 0,
			elapsed: 0,
		},
	);
	return {
		fixtureCount: scores.length,
		seededDefectHitRate:
			totals.expected === 0 ? 1 : totals.matched / totals.expected,
		falsePositiveCount: totals.falsePositives,
		invalidFindingCount: totals.invalid,
		outOfScopeFindingCount: totals.outOfScope,
		duplicateCount: totals.duplicates,
		usefulnessRate: scores.length === 0 ? 0 : totals.usefulness / scores.length,
		signalToNoiseRatio: totals.matched / Math.max(1, totals.falsePositives),
		calls: totals.calls,
		estimatedTokens: totals.tokens,
		elapsedMs: totals.elapsed,
	};
}

function matchesFinding(
	finding: BenchFinding,
	matcher: FindingMatcher,
): boolean {
	if (
		matcher.path &&
		normalizePath(finding.file) !== normalizePath(matcher.path)
	) {
		return false;
	}
	if (
		matcher.lineStart !== undefined &&
		(finding.line === undefined || finding.line < matcher.lineStart)
	) {
		return false;
	}
	if (
		matcher.lineEnd !== undefined &&
		(finding.line === undefined || finding.line > matcher.lineEnd)
	) {
		return false;
	}
	if (matcher.riskCode && finding.riskCode !== matcher.riskCode) return false;
	if (
		matcher.minSeverity &&
		SEVERITY_RANK[finding.severity] < SEVERITY_RANK[matcher.minSeverity]
	) {
		return false;
	}
	return (
		!matcher.summaryIncludes ||
		finding.summary
			.toLowerCase()
			.includes(matcher.summaryIncludes.toLowerCase())
	);
}

function countDuplicateFindings(findings: readonly BenchFinding[]): number {
	const seen = new Set<string>();
	let duplicates = 0;
	for (const finding of findings) {
		const key = [
			normalizePath(finding.file),
			finding.line ?? "",
			finding.riskCode ?? "",
			finding.severity,
			finding.summary.trim().toLowerCase(),
		].join("\u0000");
		if (seen.has(key)) duplicates += 1;
		else seen.add(key);
	}
	return duplicates;
}

async function readFixtureFile(
	directory: string,
	fileName: string,
	field: string,
): Promise<string> {
	return readFile(join(directory, fixtureFileName(fileName, field)), "utf8");
}

function matcherArray(value: unknown, field: string): FindingMatcher[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	return value.map((item, index) => parseMatcher(item, `${field}[${index}]`));
}

function parseBenchFinding(value: unknown, field: string): BenchFinding {
	if (!isPlainRecord(value)) throw new Error(`${field} must be an object`);
	const file = requiredString(value.file, `${field}.file`);
	const summary = requiredString(value.summary, `${field}.summary`);
	if (!isBenchSeverity(value.severity)) {
		throw new Error(`${field}.severity is invalid`);
	}
	const line = optionalPositiveInteger(value.line, `${field}.line`);
	const riskCode = optionalString(value.riskCode, `${field}.riskCode`);
	return {
		file,
		...(line === undefined ? {} : { line }),
		severity: value.severity,
		...(riskCode ? { riskCode } : {}),
		summary,
	};
}

function parseMatcher(value: unknown, field: string): FindingMatcher {
	if (!isPlainRecord(value)) throw new Error(`${field} must be an object`);
	const path = optionalString(value.path, `${field}.path`);
	const riskCode = optionalString(value.riskCode, `${field}.riskCode`);
	const summaryIncludes = optionalString(
		value.summaryIncludes,
		`${field}.summaryIncludes`,
	);
	const lineStart = optionalPositiveInteger(
		value.lineStart,
		`${field}.lineStart`,
	);
	const lineEnd = optionalPositiveInteger(value.lineEnd, `${field}.lineEnd`);
	if (lineStart !== undefined && lineEnd !== undefined && lineStart > lineEnd) {
		throw new Error(`${field}.lineStart cannot exceed lineEnd`);
	}
	if (value.minSeverity !== undefined && !isBenchSeverity(value.minSeverity)) {
		throw new Error(`${field}.minSeverity is invalid`);
	}
	if (!path && !riskCode && !summaryIncludes && lineStart === undefined) {
		throw new Error(`${field} must constrain at least one finding field`);
	}
	return {
		...(path ? { path } : {}),
		...(lineStart === undefined ? {} : { lineStart }),
		...(lineEnd === undefined ? {} : { lineEnd }),
		...(riskCode ? { riskCode } : {}),
		...(value.minSeverity ? { minSeverity: value.minSeverity } : {}),
		...(summaryIncludes ? { summaryIncludes } : {}),
	};
}

function fixtureFileName(value: unknown, field: string): string {
	const fileName = requiredString(value, field);
	if (
		isAbsolute(fileName) ||
		fileName.includes("/") ||
		fileName.includes("\\")
	) {
		throw new Error(`${field} must be a file name`);
	}
	return fileName;
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${field} must be an array of strings`);
	}
	return [...value];
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, field);
}

function optionalPositiveInteger(
	value: unknown,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive integer`);
	}
	return value;
}

function optionalNonNegativeNumber(
	value: unknown,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a non-negative number`);
	}
	return value;
}

function isBenchSeverity(value: unknown): value is BenchSeverity {
	return typeof value === "string" && Object.hasOwn(SEVERITY_RANK, value);
}

function isMaterialityExpectation(
	value: unknown,
): value is MaterialityExpectation {
	return value === "must-find" || value === "should-find" || value === "clean";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
