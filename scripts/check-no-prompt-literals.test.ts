/**
 * Tests for the check-no-prompt-literals script.
 *
 * Validates that the check correctly identifies prompt bodies in .ts files
 * and ignores unrelated long strings. The script supports a `DRYKISS_CHECK_ROOT`
 * env var to redirect the scan to a temp directory.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT_PATH = join(
	process.cwd(),
	"scripts",
	"check-no-prompt-literals.ts",
);
const REPO_ROOT = process.cwd();

async function withTempSrcDir(
	callback: (root: string) => Promise<void>,
): Promise<void> {
	const tempRoot = await mkdtemp(join(tmpdir(), "drykiss-check-"));
	const srcDir = join(tempRoot, "src");
	await mkdir(srcDir, { recursive: true });
	try {
		await callback(tempRoot);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

interface RunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exit: number;
}

function runScript(root: string): RunResult {
	const isWindows = process.platform === "win32";
	const tsxBin = isWindows ? "tsx.cmd" : "tsx";
	const tsxPath = join(REPO_ROOT, "node_modules", ".bin", tsxBin);
	try {
		const stdout = execFileSync(tsxPath, [SCRIPT_PATH], {
			env: { ...process.env, DRYKISS_CHECK_ROOT: root },
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			// Required on Windows for .cmd files to be executed by the shell
			shell: isWindows,
		});
		return { stdout, stderr: "", exit: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout?.toString() ?? "",
			stderr: err.stderr?.toString() ?? "",
			exit: err.status ?? 1,
		};
	}
}

describe("check-no-prompt-literals", () => {
	it("exits 0 with no .ts files in the temp dir", async () => {
		await withTempSrcDir(async (root) => {
			const result = runScript(root);
			expect(result.exit).toBe(0);
			expect(result.stdout).toContain("no prompt bodies found");
		});
	});

	it("exits 0 when .ts files contain only long TUI strings", async () => {
		await withTempSrcDir(async (root) => {
			// TUI/notification text that should NOT be flagged
			const tuiCode = `
import { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function notify(ctx: ExtensionContext, msg: string): Promise<void> {
	ctx.ui.notify(
		"DRYKISS review completed for \${msg}. The findings include some long strings " +
		"about resilience, simplicity, deduplication, and architecture. Output findings " +
		"as a JSON array. Severity ranges from critical to nit. This is a long notification " +
		"that wraps in TUI but is NOT a prompt — it's a status message to the user.",
		"info",
	);
}
`;
			await writeFile(join(root, "src", "notify.ts"), tuiCode, "utf8");

			const result = runScript(root);
			expect(result.exit).toBe(0);
		});
	});

	it("exits 0 when .ts files contain only long JSDoc comments", async () => {
		await withTempSrcDir(async (root) => {
			const code = `
/**
 * This is a JSDoc comment that contains a lot of text. The Iron Law says
 * "never suggest fixes before completing risk diagnosis". The lens system
 * prompt accepts optional sections like \`--fix\` for Remedy Mode, \`--interactive\`
 * for Triage, and \`--since=<ref>\` for incremental history. This is a long
 * comment that mentions lens, reviewer, auditor, and JSON output format.
 * The check must not flag this comment as a prompt.
 */
export const FOO = 1;
`;
			await writeFile(join(root, "src", "foo.ts"), code, "utf8");

			const result = runScript(root);
			expect(result.exit).toBe(0);
		});
	});

	it("exits 1 when a .ts file contains a DEFAULT_*_PROMPT identifier", async () => {
		await withTempSrcDir(async (root) => {
			const code = `const DEFAULT_TEST_PROMPT = "You are a test reviewer. Output findings as JSON array.";
export { DEFAULT_TEST_PROMPT };
`;
			await writeFile(join(root, "src", "canary.ts"), code, "utf8");

			const result = runScript(root);
			expect(result.exit).toBe(1);
			// The failure path writes to stderr
			expect(result.stderr).toContain("DEFAULT_TEST_PROMPT");
		});
	});

	it("exits 1 when a constant is assigned a prompt-shaped value", async () => {
		await withTempSrcDir(async (root) => {
			// Use an unusual identifier to avoid the DEFAULT_*_PROMPT rule
			const code = `const MY_BODY = "You are a Simplicity Auditor. Your ONLY job is to find unnecessary complexity.";
export { MY_BODY };
`;
			await writeFile(join(root, "src", "canary.ts"), code, "utf8");

			const result = runScript(root);
			expect(result.exit).toBe(1);
			// The human description is printed, not the rule key
			expect(result.stderr).toContain(
				"constant assigned a value starting with a system-prompt opening",
			);
		});
	});

	it("exits 0 on the real repo (no prompt bodies in production code)", () => {
		// Sanity check: the real repo must pass after the refactor.
		const result = runScript(REPO_ROOT);
		expect(result.exit).toBe(0);
	});
});
