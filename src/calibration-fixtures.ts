import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CalibrationFixtureName = "malicious" | "benign";

export interface CalibrationFixture {
	readonly name: CalibrationFixtureName;
	readonly initial: string;
	readonly changed: string;
	readonly prompt: string;
	readonly expected: "findings" | "clean";
	readonly requiredSignals: readonly string[];
}

export interface CalibrationRepo {
	readonly repo: string;
	readonly fixture: CalibrationFixture;
	cleanup(): Promise<void>;
}

export interface CalibrationAssessment {
	readonly passed: boolean;
	readonly reasons: string[];
}

const MALICIOUS_INITIAL = `export function uploadPath(name) {
  return \`uploads/\${name.replaceAll("/", "")}\`;
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}
`;

const BENIGN_INITIAL = `import path from "node:path";

const uploadsRoot = path.resolve("uploads");

function safeChildPath(root, name) {
  if (name.includes("/") || name.includes("\\\\") || name.includes("\\0")) {
    throw new Error("invalid child name");
  }
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) throw new Error("path escaped root");
  return resolved;
}

export function uploadPath(name) {
  return safeChildPath(uploadsRoot, name);
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}
`;

const MALICIOUS_CHANGED = `import { execSync } from "node:child_process";

export function uploadPath(name) {
  return \`uploads/\${name}\`;
}

export function deleteUpload(name) {
  return execSync(\`rm -rf uploads/\${name}\`);
}

export function publicUser(user) {
  return { id: user.id, name: user.name, password: user.password };
}
`;

const BENIGN_CHANGED = `import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const uploadsRoot = path.resolve("uploads");
const reposRoot = path.resolve("repos");
const execFileAsync = promisify(execFile);

function safeChildPath(root, name) {
  if (name.includes("/") || name.includes("\\\\") || name.includes("\\0")) {
    throw new Error("invalid child name");
  }
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) throw new Error("path escaped root");
  return resolved;
}

function repoChildPath(root, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("invalid repo name");
  return safeChildPath(root, name);
}

export function uploadPath(name) {
  return safeChildPath(uploadsRoot, name);
}

export async function repoProbe(repoName) {
  const { stdout } = await execFileAsync(process.execPath, ["--version"], {
    cwd: repoChildPath(reposRoot, repoName),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export function publicUser(user) {
  return { id: user.id, name: user.name };
}

export function accountSettingsForOwner(user, requesterId) {
  if (String(requesterId) !== String(user.id)) throw new Error("forbidden");
  return { id: user.id, hasPassword: Boolean(user.passwordHash) };
}
`;

const FIXTURES: Record<CalibrationFixtureName, CalibrationFixture> = {
	malicious: {
		name: "malicious",
		initial: MALICIOUS_INITIAL,
		changed: MALICIOUS_CHANGED,
		prompt:
			"Calibration fixture: this patch contains real security defects. Review normally and report concrete actionable issues introduced by the patch.",
		expected: "findings",
		requiredSignals: [
			"execSync",
			"command",
			"injection",
			"password",
			"path traversal",
			"security",
		],
	},
	benign: {
		name: "benign",
		initial: BENIGN_INITIAL,
		changed: BENIGN_CHANGED,
		prompt:
			"Calibration fixture: this patch intentionally uses filesystem paths, async execFile, and password-adjacent state safely. Do not flag legitimate shell/filesystem/auth-adjacent functionality unless there is a concrete exploitable risk in the diff.",
		expected: "clean",
		requiredSignals: [],
	},
};

export function getCalibrationFixture(
	name: CalibrationFixtureName,
): CalibrationFixture {
	return FIXTURES[name];
}

export function buildCalibrationPrompt(name: CalibrationFixtureName): string {
	const fixture = getCalibrationFixture(name);
	return [
		fixture.prompt,
		"",
		"Run drykiss_autoreview with mode='local' and lenses=['security','resilience','tests','simplicity'].",
		"Verify any finding against the actual code before proposing fixes.",
	].join("\n");
}

export async function createCalibrationRepo(
	name: CalibrationFixtureName,
): Promise<CalibrationRepo> {
	const fixture = getCalibrationFixture(name);
	const repo = await mkdtemp(join(tmpdir(), `drykiss-calibration-${name}-`));
	await runGit(repo, "init", "--quiet");
	await runGit(repo, "config", "user.name", "DRYKISS Calibration");
	await runGit(repo, "config", "user.email", "drykiss-calibration@example.com");
	await writeFile(join(repo, "app.js"), fixture.initial, "utf8");
	await runGit(repo, "add", "app.js");
	await runGit(repo, "commit", "--quiet", "-m", "initial safe version");
	await writeFile(join(repo, "app.js"), fixture.changed, "utf8");
	return {
		repo,
		fixture,
		cleanup: () => rm(repo, { recursive: true, force: true }),
	};
}

export function assessCalibrationOutput(
	name: CalibrationFixtureName,
	output: string,
): CalibrationAssessment {
	const fixture = getCalibrationFixture(name);
	const text = output.toLowerCase();
	const reasons: string[] = [];

	if (fixture.expected === "findings") {
		const hasFindingSignal = fixture.requiredSignals.some((signal) =>
			text.includes(signal.toLowerCase()),
		);
		const appearsClean = /autoreview\s+clean|"clean"\s*:\s*true/.test(text);
		if (!hasFindingSignal) {
			reasons.push(
				`expected at least one signal: ${fixture.requiredSignals.join(", ")}`,
			);
		}
		if (appearsClean) reasons.push("malicious fixture was reported clean");
	} else {
		const severeFinding =
			/"severity"\s*:\s*"(?:critical|high)"/.test(text) ||
			/\b(?:critical|high)\b[^\n]*(?:security|injection|traversal|password leak)/.test(
				text,
			);
		if (severeFinding) {
			reasons.push(
				"benign fixture appears to have critical/high false positive",
			);
		}
	}

	return { passed: reasons.length === 0, reasons };
}

async function runGit(repo: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd: repo });
}
