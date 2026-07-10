import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadReviewBenchFixtures,
	parseReviewBenchRun,
	scoreReviewBenchRun,
	summarizeReviewBenchScores,
	type ReviewBenchRun,
} from "../src/review-bench.js";

export interface ScoreArtifact {
	readonly schemaVersion: 1;
	readonly kind: "review-bench-score";
	readonly generatedAt: string;
	readonly sourceResults: string;
	readonly scores: ReturnType<typeof scoreReviewBenchRun>[];
	readonly summary: ReturnType<typeof summarizeReviewBenchScores>;
}

export interface ReviewBenchCliResult {
	readonly outputPath: string;
	readonly artifact: ScoreArtifact;
}

export async function runReviewBenchCli(
	argv: readonly string[],
	cwd = process.cwd(),
): Promise<ReviewBenchCliResult> {
	const args = parseCliArgs(argv);
	if (!args.results) {
		throw new Error(
			"Usage: review-bench --results <recorded-runs.json> [--out <score.json>] [--fixtures <dir>]",
		);
	}
	const fixturesRoot = resolve(cwd, args.fixtures ?? "fixtures/review-bench");
	const resultsPath = resolve(cwd, args.results);
	const outputPath = resolve(cwd, args.out ?? defaultOutputPath(resultsPath));
	const [fixtures, recordedRuns] = await Promise.all([
		loadReviewBenchFixtures(fixturesRoot),
		loadRecordedRuns(resultsPath),
	]);
	const fixturesById = new Map(
		fixtures.map((fixture) => [fixture.manifest.id, fixture]),
	);
	const scores = recordedRuns.map((run) => {
		const fixture = fixturesById.get(run.fixtureId);
		if (!fixture) {
			throw new Error(`No fixture found for recorded run ${run.fixtureId}`);
		}
		return scoreReviewBenchRun(fixture, run);
	});
	const artifact: ScoreArtifact = {
		schemaVersion: 1,
		kind: "review-bench-score",
		generatedAt: new Date().toISOString(),
		sourceResults: resultsPath,
		scores,
		summary: summarizeReviewBenchScores(scores),
	};
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
	return { outputPath, artifact };
}

export function parseCliArgs(argv: readonly string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
			throw new Error(`Invalid argument near ${flag ?? "<end>"}`);
		}
		args[flag.slice(2)] = value;
	}
	return args;
}

async function loadRecordedRuns(path: string): Promise<readonly ReviewBenchRun[]> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not parse ${path}: ${message}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must contain schemaVersion 1 and a runs array`);
	}
	const artifact = value as Record<string, unknown>;
	if (artifact.schemaVersion !== 1 || !Array.isArray(artifact.runs)) {
		throw new Error(`${path} must contain schemaVersion 1 and a runs array`);
	}
	return artifact.runs.map((run, index) =>
		parseReviewBenchRun(run, `runs[${index}]`),
	);
}

function defaultOutputPath(resultsPath: string): string {
	return `${resultsPath}.score.json`;
}

async function main(): Promise<void> {
	const result = await runReviewBenchCli(process.argv.slice(2));
	process.stdout.write(`Review-bench score written to ${result.outputPath}\n`);
	process.stdout.write(`${JSON.stringify(result.artifact.summary, null, 2)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
	void main().catch((err: unknown) => {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	});
}
