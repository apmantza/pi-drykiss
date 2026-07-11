import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCliArgs, runReviewBenchCli } from "./review-bench.js";

const fixtureRoot = fileURLToPath(
	new URL("../fixtures/review-bench", import.meta.url),
);

describe("review-bench CLI", () => {
	it("rejects malformed command-line arguments", () => {
		expect(() => parseCliArgs(["--results"])).toThrow("Invalid argument");
		expect(() => parseCliArgs(["results", "runs.json"])).toThrow(
			"Invalid argument",
		);
	});

	it("scores a recorded artifact and writes a versioned result", async () => {
		const directory = await mkdtemp(join(tmpdir(), "drykiss-review-bench-"));
		const resultsPath = join(directory, "runs.json");
		const outputPath = join(directory, "score.json");
		try {
			await writeFile(
				resultsPath,
				JSON.stringify({
					schemaVersion: 1,
					runs: [
						{
							fixtureId: "command-injection",
							findings: [
								{
									file: "app.js",
									line: 9,
									severity: "high",
									riskCode: "S1",
									summary: "Command injection",
								},
							],
						},
						{ fixtureId: "safe-exec", findings: [] },
					],
				}),
				"utf8",
			);

			const result = await runReviewBenchCli(
				[
					"--fixtures",
					fixtureRoot,
					"--results",
					resultsPath,
					"--out",
					outputPath,
				],
				directory,
			);

			expect(result.artifact.summary.seededDefectHitRate).toBe(1);
			expect(result.artifact.summary.falsePositiveCount).toBe(0);
			const written = JSON.parse(await readFile(outputPath, "utf8")) as {
				schemaVersion: number;
				kind: string;
			};
			expect(written).toEqual(
				expect.objectContaining({
					schemaVersion: 1,
					kind: "review-bench-score",
				}),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects recorded runs for unknown fixtures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "drykiss-review-bench-"));
		const resultsPath = join(directory, "runs.json");
		try {
			await writeFile(
				resultsPath,
				JSON.stringify({
					schemaVersion: 1,
					runs: [{ fixtureId: "unknown", findings: [] }],
				}),
				"utf8",
			);

			await expect(
				runReviewBenchCli(
					["--fixtures", fixtureRoot, "--results", resultsPath],
					directory,
				),
			).rejects.toThrow("No fixture found for recorded run unknown");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
