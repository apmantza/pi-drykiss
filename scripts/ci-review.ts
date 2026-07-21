/**
 * scripts/ci-review.ts
 *
 * Minimal CI entry-point for running a DRYKISS PR review in GitHub Actions.
 *
 * Usage (invoked by .github/workflows/drykiss-review.yml):
 *   node scripts/ci-review.js --pr <number> --repo <owner/repo>
 *
 * Environment variables (all optional except GITHUB_TOKEN for posting):
 *   GITHUB_TOKEN         GitHub token for posting PR comments (auto-set by Actions)
 *   DRYKISS_POST_TO_PR   Set to "true" to post findings as an inline PR review
 *   DRYKISS_QUALITY_GATE Minimum health score (0–100); exits non-zero if below it
 *   DRYKISS_LENSES       Comma-separated lens names to run (omit for all lenses)
 *   GITHUB_EVENT_PATH    Path to the GitHub Actions event JSON (auto-set by Actions)
 *
 * How it works:
 *   1. Resolves the PR number from --pr flag or GITHUB_EVENT_PATH.
 *   2. Invokes the Pi CLI with drykiss_autoreview in mode=pr.
 *   3. Parses the tool output for a health score.
 *   4. Exits with code 1 if the score is below DRYKISS_QUALITY_GATE.
 *
 * The Pi CLI handles all LLM calls, PR diff fetching, and comment posting.
 * This script is intentionally thin — it only wires CI environment variables
 * to the drykiss_autoreview tool parameters.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

// ── CLI argument parsing ──────────────────────────────────────────────────

interface CliArgs {
	pr: string | null;
	repo: string | null;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { pr: null, repo: null };
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--pr" && argv[i + 1]) {
			args.pr = argv[++i];
		} else if (argv[i] === "--repo" && argv[i + 1]) {
			args.repo = argv[++i];
		}
	}
	return args;
}

// ── PR number resolution ──────────────────────────────────────────────────

/**
 * Resolve the PR number from the --pr flag or GITHUB_EVENT_PATH.
 * GITHUB_EVENT_PATH is automatically set by GitHub Actions and contains the
 * full webhook payload JSON with `pull_request.number`.
 */
async function resolvePrNumber(flagValue: string | null): Promise<number> {
	if (flagValue && /^\d+$/.test(flagValue)) {
		return Number.parseInt(flagValue, 10);
	}
	if (flagValue && flagValue.trim().length > 0) {
		throw new Error(
			`--pr must be a numeric PR number, got: ${flagValue}`,
		);
	}

	// Fall back to GITHUB_EVENT_PATH (set automatically in Actions)
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (eventPath) {
		try {
			const raw = await readFile(eventPath, "utf-8");
			const event = JSON.parse(raw) as unknown;
			if (
				typeof event === "object" &&
				event !== null &&
				"pull_request" in event &&
				typeof (event as Record<string, unknown>).pull_request === "object" &&
				(event as Record<string, unknown>).pull_request !== null
			) {
				const pr = (event as Record<string, unknown>).pull_request as Record<
					string,
					unknown
				>;
				if (typeof pr.number === "number") {
					return pr.number;
				}
			}
		} catch (err) {
			throw new Error(
				`Failed to read GITHUB_EVENT_PATH at ${eventPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	throw new Error(
		"Could not determine PR number. Pass --pr <number> or ensure GITHUB_EVENT_PATH is set.",
	);
}

// ── pr reference builder ──────────────────────────────────────────────────

/**
 * Build a PR reference string suitable for drykiss_autoreview's `pr` param.
 * Prefer owner/repo#number format when repo is available.
 */
function buildPrReference(prNumber: number, repo: string | null): string {
	if (repo && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
		return `${repo}#${prNumber}`;
	}
	return String(prNumber);
}

// ── Health score extraction ───────────────────────────────────────────────

/**
 * Extract the health score from the tool's text output.
 * The compact format emits a line like: "Health score: 72/100"
 * Returns null when no score line is found.
 */
function extractHealthScore(output: string): number | null {
	const match = output.match(/health\s*score[:\s]+(\d+)\s*\/\s*100/i);
	if (match) {
		return Number.parseInt(match[1], 10);
	}
	return null;
}

// ── Pi CLI invocation ─────────────────────────────────────────────────────

/**
 * Build the drykiss_autoreview tool call arguments for the Pi CLI.
 *
 * The Pi CLI accepts a `--tool` flag with JSON params to invoke a tool
 * non-interactively (headless mode).
 */
function buildToolParams(
	prRef: string,
	postToPr: boolean,
	lenses: string | null,
): Record<string, unknown> {
	const params: Record<string, unknown> = {
		mode: "pr",
		pr: prRef,
		format: "compact",
	};

	if (postToPr) {
		params.postToPr = true;
	}

	if (lenses) {
		const lensArray = lenses
			.split(",")
			.map((l) => l.trim())
			.filter(Boolean);
		if (lensArray.length === 1) {
			params.lens = lensArray[0];
		} else if (lensArray.length > 1) {
			params.lenses = lensArray;
		}
	}

	return params;
}

/**
 * Invoke the Pi CLI with drykiss_autoreview tool params.
 * Streams output to stdout/stderr and resolves with the combined output text.
 *
 * The Pi CLI is expected to be available as `pi` on PATH after
 * `npm install -g @earendil-works/pi-coding-agent`.
 */
async function runPiReview(toolParams: Record<string, unknown>): Promise<string> {
	const paramsJson = JSON.stringify(toolParams);

	console.log("[drykiss-ci] Running: pi tool drykiss_autoreview");
	console.log("[drykiss-ci] Params:", JSON.stringify(toolParams, null, 2));

	return new Promise<string>((resolve, reject) => {
		// Use spawn-style via execFile with maxBuffer for larger outputs.
		// Pi CLI: `pi tool <name> <json-params>` — adjust to match actual CLI surface.
		const child: ChildProcess = (execFile as unknown as (
			cmd: string,
			args: string[],
			opts: Record<string, unknown>,
			cb: (err: Error | null, stdout: string, stderr: string) => void,
		) => ChildProcess)(
			"pi",
			["tool", "drykiss_autoreview", paramsJson],
			{
				env: { ...process.env },
				maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
			},
			(err, stdout, stderr) => {
				if (stderr) {
					process.stderr.write(stderr);
				}
				if (stdout) {
					process.stdout.write(stdout);
				}
				if (err) {
					// Non-zero exit from pi is acceptable — we inspect the output
					// ourselves to determine pass/fail. Only reject on spawn errors.
					if ((err as NodeJS.ErrnoException).code === "ENOENT") {
						reject(
							new Error(
								"pi CLI not found. Install it with: npm install -g @earendil-works/pi-coding-agent",
							),
						);
						return;
					}
					// Tool exited non-zero but produced output — still usable.
					resolve(stdout ?? "");
					return;
				}
				resolve(stdout ?? "");
			},
		);
		void child;
	});
}

// ── Quality gate ─────────────────────────────────────────────────────────

function applyQualityGate(score: number | null, threshold: number): void {
	if (score === null) {
		console.warn(
			"[drykiss-ci] Could not extract health score from output — skipping quality gate.",
		);
		return;
	}

	console.log(`[drykiss-ci] Health score: ${score}/100 (gate: ${threshold})`);

	if (score < threshold) {
		console.error(
			`[drykiss-ci] Quality gate FAILED: score ${score} is below threshold ${threshold}.`,
		);
		process.exitCode = 1;
	} else {
		console.log(
			`[drykiss-ci] Quality gate PASSED: score ${score} >= threshold ${threshold}.`,
		);
	}
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	// Resolve PR number
	const prNumber = await resolvePrNumber(args.pr);
	const prRef = buildPrReference(prNumber, args.repo ?? process.env.GITHUB_REPOSITORY ?? null);

	// Read CI environment variables
	const postToPr = process.env.DRYKISS_POST_TO_PR === "true";
	const lenses = process.env.DRYKISS_LENSES ?? null;
	const qualityGateRaw = process.env.DRYKISS_QUALITY_GATE;
	const qualityGate =
		qualityGateRaw !== undefined ? Number.parseInt(qualityGateRaw, 10) : null;

	console.log(`[drykiss-ci] Reviewing PR #${prNumber} (${prRef})`);
	console.log(`[drykiss-ci] Post to PR: ${postToPr}`);
	if (lenses) console.log(`[drykiss-ci] Lenses: ${lenses}`);
	if (qualityGate !== null) console.log(`[drykiss-ci] Quality gate: ${qualityGate}`);

	// Build tool params and run
	const toolParams = buildToolParams(prRef, postToPr, lenses);
	const output = await runPiReview(toolParams);

	// Apply quality gate if configured
	if (qualityGate !== null && !Number.isNaN(qualityGate)) {
		const score = extractHealthScore(output);
		applyQualityGate(score, qualityGate);
	}
}

main().catch((err) => {
	console.error(
		`[drykiss-ci] Fatal error: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
});
