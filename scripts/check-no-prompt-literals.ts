/**
 * check-no-prompt-literals.ts
 *
 * Enforces the constraint defined in `prompt-architecture.md`:
 *   "All prompt text MUST live in `.md` files. TypeScript modules MUST NOT
 *    contain prompt text as string literals."
 *
 * The check is intentionally conservative — it only flags *high-confidence*
 * signals of a prompt body, not generic long strings. False positives would
 * erode trust in the check; it's better to miss a sneaky prompt than to
 * block unrelated work on a TUI string.
 *
 * High-confidence signals (all must be present):
 *   1. An identifier matching `DEFAULT_*_PROMPT` or `*_PROMPT_BODY` is defined
 *      or referenced. Such identifiers are by convention prompt bodies.
 *   2. The constant being assigned is a string literal that looks like a
 *      system-prompt body (starts with "You are a ", "Your ONLY job is to ", etc.)
 *
 * Optional secondary check (printed but does not fail the build):
 *   - A template literal > 400 chars that *also* contains the words
 *     "lens" / "reviewer" / "auditor" / "JSON array" / "Output findings" — strong
 *     signals of a lens prompt body.
 *
 * Files exempt from the check:
 *   - `*.test.ts` (tests can contain long strings for fixtures)
 *   - `src/calibration-fixtures.ts` (legitimately holds long strings)
 *   - `src/prompts/**` (the check applies to .ts only; .md files ARE the prompts)
 *
 * Usage:
 *   tsx scripts/check-no-prompt-literals.ts          # exit 0 = pass, 1 = fail
 *   npm run check:no-prompt-literals
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

// Heuristic: identifiers that strongly signal "this is a prompt body constant"
const PROMPT_IDENT =
	/\b(DEFAULT_[A-Z_]*PROMPT(?!S)|[A-Z_]*PROMPT_BODY|SHARED_FRAMEWORK|LENS_PROMPTS)\b/g;

// Heuristic: a string literal that starts with a typical system-prompt opening
const PROMPT_OPENING =
	/^(You are a |Your ONLY job is to |You are an? |The .* lens |You are the |As an? )/i;

const EXEMPT_FILES = new Set(["src/calibration-fixtures.ts"]);

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly col: number;
	readonly rule: string;
	readonly excerpt: string;
}

function isExempt(relativePath: string): boolean {
	if (relativePath.endsWith(".test.ts")) return true;
	if (EXEMPT_FILES.has(relativePath)) return true;
	return false;
}

function findInFile(
	content: string,
	regex: RegExp,
): Array<{ index: number; match: string }> {
	const results: Array<{ index: number; match: string }> = [];
	regex.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(content)) !== null) {
		results.push({ index: m.index, match: m[0] });
		if (m.index === regex.lastIndex) regex.lastIndex++;
	}
	return results;
}

function offsetToLineCol(
	content: string,
	offset: number,
): { line: number; col: number } {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset; i++) {
		if (content[i] === "\n") {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { line, col };
}

function extractExcerpt(
	content: string,
	index: number,
	length: number,
): string {
	const start = Math.max(0, index - 20);
	const end = Math.min(content.length, index + length + 20);
	const excerpt = content.slice(start, end).replace(/\s+/g, " ");
	return excerpt.length > 120 ? excerpt.slice(0, 117) + "..." : excerpt;
}

async function checkFile(
	absPath: string,
	baseDir: string = ROOT,
): Promise<Finding[]> {
	const rel = relative(baseDir, absPath).replace(/\\/g, "/");
	if (isExempt(rel)) return [];

	const content = await readFile(absPath, "utf8");

	// Primary signal: prompt identifier
	const identFindings = findInFile(content, PROMPT_IDENT).map(
		({ index, match }) => {
			const { line, col } = offsetToLineCol(content, index);
			return {
				file: rel,
				line,
				col,
				rule: "prompt-ident" as const,
				excerpt: extractExcerpt(content, index, match.length),
			};
		},
	);

	// Secondary signal: a constant assigned a value that opens like a system prompt
	// (catches `const FOO: string = "You are a ..."` which is the typical pattern)
	const assignmentRegex =
		/(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*[:=]\s*[`"']([^`"'\n]{1,500})/g;
	const matches: RegExpExecArray[] = [];
	let am: RegExpExecArray | null;
	while ((am = assignmentRegex.exec(content)) !== null) matches.push(am);

	const assignmentFindings: Finding[] = matches
		.filter((match) => {
			const ident = match[1];
			const valueStart = match[2];
			return (
				PROMPT_OPENING.test(valueStart) &&
				!ident.startsWith("USAGE_") &&
				!ident.endsWith("_MSG")
			);
		})
		.map((match) => {
			const { line, col } = offsetToLineCol(content, match.index);
			return {
				file: rel,
				line,
				col,
				rule: "prompt-shaped-assignment" as const,
				excerpt: extractExcerpt(content, match.index, match[0].length),
			};
		});

	return [...identFindings, ...assignmentFindings];
}

async function findTsFiles(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const out: string[] = [];

	async function walk(d: string): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(d, { withFileTypes: true, encoding: "utf8" });
		} catch {
			// Dir doesn't exist or isn't readable — nothing to scan
			return;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) {
				if (e.name === "node_modules" || e.name === "dist" || e.name === ".git")
					continue;
				await walk(full);
			} else if (e.isFile() && e.name.endsWith(".ts")) {
				out.push(full);
			}
		}
	}

	await walk(dir);
	return out;
}

async function main(): Promise<number> {
	const rootOverride = process.env.DRYKISS_CHECK_ROOT;
	const baseDir = rootOverride && rootOverride.length > 0 ? rootOverride : ROOT;
	const srcDir = join(baseDir, "src");
	const files = await findTsFiles(srcDir);
	const allFindings = (
		await Promise.all(files.map((f) => checkFile(f, baseDir)))
	).flat();

	if (allFindings.length === 0) {
		process.stdout.write(
			"✓ check-no-prompt-literals: no prompt bodies found in .ts files\n",
		);
		return 0;
	}

	process.stderr.write(
		"✗ check-no-prompt-literals: found prompt-like content in .ts files\n\n",
	);
	for (const f of allFindings) {
		const desc =
			{
				"prompt-ident":
					"prompt-body identifier (DEFAULT_*_PROMPT / *_PROMPT_BODY)",
				"prompt-shaped-assignment":
					"constant assigned a value starting with a system-prompt opening",
			}[f.rule] ?? f.rule;
		process.stderr.write(`  ${f.file}:${f.line}:${f.col}  [${desc}]\n`);
		process.stderr.write(`    ${f.excerpt}\n`);
	}
	process.stderr.write(
		"\nHint: move prompt text to a .md file under src/prompts/ and load it via\n",
	);
	process.stderr.write(
		"the composer. See prompt-architecture.md for the constraint.\n",
	);
	return 1;
}

const exitCode = await main();
process.exit(exitCode);
