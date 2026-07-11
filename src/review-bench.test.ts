import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	loadReviewBenchFixture,
	loadReviewBenchFixtures,
	parseReviewBenchManifest,
	parseReviewBenchRun,
	scoreReviewBenchRun,
	summarizeReviewBenchScores,
} from "./review-bench.js";

const fixtureRoot = fileURLToPath(
	new URL("../fixtures/review-bench", import.meta.url),
);

describe("review-bench fixtures", () => {
	it("loads the versioned PR-style fixtures", async () => {
		const fixtures = await loadReviewBenchFixtures(fixtureRoot);

		expect(fixtures.map((fixture) => fixture.manifest.id)).toEqual([
			"command-injection",
			"safe-exec",
		]);
		expect(fixtures[0]?.diff).toContain("execSync");
		expect(fixtures[1]?.context).toContain("execFileAsync");
	});

	it("reports malformed fixture manifests with their path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "drykiss-review-bench-"));
		try {
			await mkdir(join(directory, "broken"));
			await writeFile(join(directory, "broken", "manifest.json"), "{", "utf8");

			await expect(
				loadReviewBenchFixture(join(directory, "broken")),
			).rejects.toThrow("Could not parse");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects clean fixtures that require seeded findings", () => {
		expect(() =>
			parseReviewBenchManifest({
				schemaVersion: 1,
				id: "invalid",
				title: "Invalid",
				diffFile: "diff.patch",
				scopePaths: ["app.js"],
				expectedFindings: [{ path: "app.js" }],
				allowedNonFindings: [],
				knownFalsePositiveTraps: [],
				materiality: "clean",
			}),
		).toThrow("clean fixtures cannot require findings");
	});

	it("normalizes scope paths and rejects inherited severity names", () => {
		const manifest = parseReviewBenchManifest({
			schemaVersion: 1,
			id: "normalized",
			title: "Normalized",
			diffFile: "diff.patch",
			scopePaths: ["./app.js"],
			expectedFindings: [],
			allowedNonFindings: [],
			knownFalsePositiveTraps: [],
			materiality: "clean",
		});

		expect(manifest.scopePaths).toEqual(["app.js"]);
		expect(() =>
			parseReviewBenchRun({
				fixtureId: "normalized",
				findings: [
					{
						file: "app.js",
						severity: "toString",
						summary: "Invalid severity",
					},
				],
			}),
		).toThrow("severity is invalid");
	});
});

describe("scoreReviewBenchRun", () => {
	it("scores seeded hits, false positives, duplicates, and out-of-scope findings", async () => {
		const [fixture] = await loadReviewBenchFixtures(fixtureRoot);
		if (!fixture) throw new Error("command-injection fixture missing");

		const score = scoreReviewBenchRun(fixture, {
			fixtureId: "command-injection",
			findings: [
				{
					file: "app.js",
					line: 9,
					severity: "high",
					riskCode: "S1",
					summary: "Command injection through execSync",
				},
				{
					file: "app.js",
					line: 9,
					severity: "high",
					riskCode: "S1",
					summary: "Command injection through execSync",
				},
				{
					file: "unrelated.js",
					line: 2,
					severity: "low",
					summary: "Unrelated style concern",
				},
			],
			invalidFindingCount: 1,
			calls: 3,
			estimatedTokens: 900,
			elapsedMs: 1200,
		});

		expect(score).toMatchObject({
			matchedExpectedCount: 1,
			missedExpectedFindings: [],
			falsePositiveCount: 1,
			invalidFindingCount: 1,
			outOfScopeFindingCount: 1,
			duplicateCount: 1,
			usefulnessRate: 0.5,
			signalToNoiseRatio: 1,
		});
	});

	it("reports missing or insufficient seeded findings", async () => {
		const [fixture] = await loadReviewBenchFixtures(fixtureRoot);
		if (!fixture) throw new Error("command-injection fixture missing");

		const missing = scoreReviewBenchRun(fixture, {
			fixtureId: fixture.manifest.id,
			findings: [],
		});
		const insufficient = scoreReviewBenchRun(fixture, {
			fixtureId: fixture.manifest.id,
			findings: [
				{
					file: "app.js",
					line: 9,
					severity: "medium",
					riskCode: "S1",
					summary: "Command injection through execSync",
				},
			],
		});

		expect(missing.matchedExpectedCount).toBe(0);
		expect(missing.missedExpectedFindings).toHaveLength(1);
		expect(missing.usefulnessRate).toBe(0);
		expect(insufficient.matchedExpectedCount).toBe(0);
		expect(insufficient.missedExpectedFindings).toHaveLength(1);
	});

	it("does not penalize allowed benign findings", async () => {
		const fixtures = await loadReviewBenchFixtures(fixtureRoot);
		const fixture = fixtures.find(
			(candidate) => candidate.manifest.id === "safe-exec",
		);
		if (!fixture) throw new Error("safe-exec fixture missing");

		const score = scoreReviewBenchRun(fixture, {
			fixtureId: "safe-exec",
			findings: [
				{
					file: "app.js",
					line: 12,
					severity: "low",
					summary: "execFile usage is documented and bounded",
				},
			],
		});

		expect(score.falsePositiveCount).toBe(0);
		expect(score.matchedExpectedCount).toBe(0);
		expect(score.usefulnessRate).toBe(0);
		expect(score.signalToNoiseRatio).toBe(0);
	});

	it("rejects malformed recorded runs", () => {
		expect(() => parseReviewBenchRun({ fixtureId: "", findings: [] })).toThrow(
			"fixtureId must be a non-empty string",
		);
		expect(() =>
			parseReviewBenchRun({
				fixtureId: "command-injection",
				findings: [],
				calls: -1,
			}),
		).toThrow("calls must be a non-negative number");
	});

	it("aggregates deterministic benchmark metrics", async () => {
		const fixtures = await loadReviewBenchFixtures(fixtureRoot);
		const scores = fixtures.map((fixture) =>
			scoreReviewBenchRun(fixture, {
				fixtureId: fixture.manifest.id,
				findings:
					fixture.manifest.id === "command-injection"
						? [
								{
									file: "app.js",
									line: 9,
									severity: "high",
									riskCode: "S1",
									summary: "Command injection",
								},
							]
						: [],
			}),
		);

		expect(summarizeReviewBenchScores(scores)).toMatchObject({
			fixtureCount: 2,
			seededDefectHitRate: 1,
			falsePositiveCount: 0,
		});
		expect(summarizeReviewBenchScores([])).toMatchObject({
			fixtureCount: 0,
			seededDefectHitRate: 1,
			usefulnessRate: 0,
		});
	});
});
