import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChangedFile } from "./types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mkdtemp,
	writeFile,
	readFile,
	readdir,
	rm,
	mkdir,
} from "node:fs/promises";

// ── Mocks ───────────────────────────────────────────────────────────────

// Mock the loader/composer layer so the tests control prompt content directly.
// The tests are about prompt-builder.ts's behavior (composition order, context
// building, seed lifecycle), not about file I/O. The actual file I/O is tested
// in prompt-loader.test.ts and prompt-composer.test.ts (planned for P0.9).
vi.mock("./prompt-loader.js", () => ({
	loadPromptBody: vi.fn(),
	bundledPromptsDir: vi.fn(() => "/bundled-prompts"),
	userPromptsDir: vi.fn(() => "/user-prompts"),
	loadPromptFile: vi.fn(),
	loadSharedFragment: vi.fn(),
}));

vi.mock("./prompt-composer.js", () => ({
	composeLensPrompt: vi.fn(),
	composeSynthesisPrompt: vi.fn(),
}));

import {
	buildBucketedSynthesisPrompt,
	buildReviewPrompts,
	buildSynthesisPrompt,
	buildAutoInjectBlock,
	ensureDefaultPrompts,
	resetPrompts,
	loadLensSystemPrompt,
	loadSynthesisSystemPrompt,
	getPromptPath,
	loadProjectReviewGuidelines,
} from "./prompt-builder.js";
import { bundledPromptsDir, userPromptsDir } from "./prompt-loader.js";
import {
	composeLensPrompt,
	composeSynthesisPrompt,
} from "./prompt-composer.js";

// ── Test helpers ────────────────────────────────────────────────────────

const mockFiles: ChangedFile[] = [
	{ path: "src/app.ts", status: "modified", language: "TypeScript" },
	{ path: "src/utils.ts", status: "added", language: "TypeScript" },
];

const mockDiffs = new Map<string, string>([
	["src/app.ts", "@@ -1,2 +1,3 @@\n+console.log('hello')"],
	["src/utils.ts", "@@ -0,0 +1,2 @@\n+export const x = 1"],
]);

/**
 * The fixture strings for each lens. Each is the *full composed system prompt*
 * (iron-law + lens body + json-output + grounding-rules + kiss-dry-checklist).
 * Tests assert substrings on these.
 */
const LENS_PROMPTS: Record<string, string> = {
	simplicity:
		"Simplicity Auditor · KISS principles · Output findings as a single JSON array · Output ONLY the JSON array · Grounding rules · Quick Self-Check · Is the new code as simple as the problem allows · Is knowledge represented once · Do variables/functions reveal intent · Do they explain WHY, not WHAT",
	deduplication:
		"Duplication Hunter · DRY principles · Output findings as a single JSON array · Output ONLY the JSON array · Grounding rules · Quick Self-Check",
	clarity:
		"Clarity & Quality Auditor · Performance Check · Output findings as a single JSON array · Output ONLY the JSON array · Grounding rules · Quick Self-Check",
	resilience:
		"Resilience Auditor · silent failures · Output findings as a single JSON array · Output ONLY the JSON array · Grounding rules · Quick Self-Check",
	architecture:
		"Architecture Auditor · SOLID · Depth · Seam · Locality · Output findings as a single JSON array · Output ONLY the JSON array · Grounding rules · Quick Self-Check",
	tests:
		"Test Coverage & Test Quality Auditor · Given-When-Then · Weak tests are false confidence · Over-mocking · Output findings as a single JSON array · Output ONLY the JSON array · Grounding rules · Quick Self-Check",
	security:
		"Security Auditor · Injection Vulnerabilities · Secrets & Credentials · Output findings as a single JSON array · Output ONLY the JSON array · Grounding rules · Quick Self-Check",
};

const SYNTHESIS_PROMPT =
	"Senior Engineer Synthesizer · critical > high > medium > low > nit · Output the final report as a single JSON object · Synthesis Grounding rules";

/** Wire the composer mock to return the right fixture for each lens. */
function setComposerFixtures(): void {
	vi.mocked(composeLensPrompt).mockImplementation(
		async (lens) => LENS_PROMPTS[lens] ?? `__unmocked__:${lens}__`,
	);
	vi.mocked(composeSynthesisPrompt).mockResolvedValue(SYNTHESIS_PROMPT);
}

beforeEach(() => {
	vi.resetAllMocks();
	setComposerFixtures();
	vi.mocked(bundledPromptsDir).mockReturnValue("/bundled-prompts");
	vi.mocked(userPromptsDir).mockReturnValue(join(tmpdir(), "user-prompts"));
});

// ── buildReviewPrompts ──────────────────────────────────────────────────

describe("buildReviewPrompts", () => {
	it("returns single prompt for simplicity lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"simplicity",
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].lens).toBe("simplicity");
		expect(prompts[0].systemPrompt).toContain("Simplicity Auditor");
		expect(prompts[0].systemPrompt).toContain("KISS");
		expect(prompts[0].userPrompt).toContain("src/app.ts");
		expect(prompts[0].userPrompt).toContain("src/utils.ts");
	});

	it("returns single prompt for deduplication lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"deduplication",
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].lens).toBe("deduplication");
		expect(prompts[0].systemPrompt).toContain("Duplication Hunter");
		expect(prompts[0].systemPrompt).toContain("DRY");
	});

	it("returns single prompt for clarity lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"clarity",
		);
		expect(prompts[0].lens).toBe("clarity");
		expect(prompts[0].systemPrompt).toContain("Clarity & Quality Auditor");
		expect(prompts[0].systemPrompt).toContain("Performance Check");
	});

	it("returns single prompt for resilience lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"resilience",
		);
		expect(prompts[0].lens).toBe("resilience");
		expect(prompts[0].systemPrompt).toContain("Resilience Auditor");
		expect(prompts[0].systemPrompt).toContain("silent failures");
	});

	it("returns single prompt for architecture lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"architecture",
		);
		expect(prompts[0].lens).toBe("architecture");
		expect(prompts[0].systemPrompt).toContain("Architecture Auditor");
		expect(prompts[0].systemPrompt).toContain("SOLID");
		expect(prompts[0].systemPrompt).toContain("Depth");
		expect(prompts[0].systemPrompt).toContain("Seam");
		expect(prompts[0].systemPrompt).toContain("Locality");
	});

	it("returns single prompt for tests lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"tests",
		);
		expect(prompts[0].lens).toBe("tests");
		expect(prompts[0].systemPrompt).toContain(
			"Test Coverage & Test Quality Auditor",
		);
		expect(prompts[0].systemPrompt).toContain("Given-When-Then");
		expect(prompts[0].systemPrompt).toContain(
			"Weak tests are false confidence",
		);
		expect(prompts[0].systemPrompt).toContain("Over-mocking");
	});

	it("returns single prompt for security lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"security",
		);
		expect(prompts[0].lens).toBe("security");
		expect(prompts[0].systemPrompt).toContain("Security Auditor");
		expect(prompts[0].systemPrompt).toContain("Injection Vulnerabilities");
		expect(prompts[0].systemPrompt).toContain("Secrets & Credentials");
	});

	it("returns all seven prompts for 'all' lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"all",
		);
		expect(prompts).toHaveLength(7);
		const lenses = prompts.map((p) => p.lens);
		expect(lenses).toContain("simplicity");
		expect(lenses).toContain("deduplication");
		expect(lenses).toContain("clarity");
		expect(lenses).toContain("resilience");
		expect(lenses).toContain("architecture");
		expect(lenses).toContain("tests");
		expect(lenses).toContain("security");
	});

	it("includes diff content in user prompt", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"simplicity",
		);
		expect(prompts[0].userPrompt).toContain("console.log('hello')");
		expect(prompts[0].userPrompt).toContain("export const x = 1");
	});

	it("handles missing diffs gracefully", async () => {
		const emptyDiffs = new Map<string, string>();
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			emptyDiffs,
			"simplicity",
		);
		expect(prompts[0].userPrompt).toContain("(diff not available)");
	});

	it("requires JSON output in system prompts", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"simplicity",
		);
		expect(prompts[0].systemPrompt).toContain(
			"Output findings as a single JSON array",
		);
		expect(prompts[0].systemPrompt).toContain("Output ONLY the JSON array");
	});

	it("includes KISS/DRY checklist in system prompts", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"simplicity",
		);
		expect(prompts[0].systemPrompt).toContain("Quick Self-Check");
		expect(prompts[0].systemPrompt).toContain(
			"Is the new code as simple as the problem allows",
		);
		expect(prompts[0].systemPrompt).toContain("Is knowledge represented once");
		expect(prompts[0].systemPrompt).toContain(
			"Do variables/functions reveal intent",
		);
		expect(prompts[0].systemPrompt).toContain("Do they explain WHY, not WHAT");
	});

	it("includes project index for deduplication lens", async () => {
		const index = [{ path: "src/lib.ts", exports: ["helper", "util"] }];
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"deduplication",
			{ projectIndex: index },
		);
		expect(prompts[0].userPrompt).toContain("Project Index");
		expect(prompts[0].userPrompt).toContain("src/lib.ts");
	});

	it("includes full file content when provided", async () => {
		const contents = new Map([
			[
				"src/app.ts",
				{ content: "export const x = 1;", lineCount: 1, truncated: false },
			],
		]);
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"simplicity",
			{ contents },
		);
		expect(prompts[0].userPrompt).toContain("Full file");
		expect(prompts[0].userPrompt).toContain("export const x = 1;");
	});

	it("passes activeConstraints to the composer", async () => {
		await buildReviewPrompts("/cwd", mockFiles, mockDiffs, "simplicity", {
			activeConstraints: "disable: [K1]",
		});
		expect(composeLensPrompt).toHaveBeenCalledWith(
			"simplicity",
			expect.objectContaining({ activeConstraints: "disable: [K1]" }),
		);
	});

	it("includes project review guidelines when provided", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"simplicity",
			{ guidelines: "Prefer small focused changes." },
		);

		expect(prompts[0].userPrompt).toContain("Project Review Guidelines");
		expect(prompts[0].userPrompt).toContain("Prefer small focused changes.");
	});

	it("automatically loads project review guidelines from the filesystem", async () => {
		const dir = await mkdtemp(join(tmpdir(), "drykiss-guidelines-"));
		try {
			await mkdir(join(dir, ".pi", "drykiss"), { recursive: true });
			await writeFile(
				join(dir, ".pi", "drykiss", "review-guidelines.md"),
				"Use project idioms.",
			);

			const prompts = await buildReviewPrompts(
				dir,
				mockFiles,
				mockDiffs,
				"simplicity",
			);

			expect(prompts[0].userPrompt).toContain("Project Review Guidelines");
			expect(prompts[0].userPrompt).toContain("Use project idioms.");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ── project guidelines ─────────────────────────────────────────────────

describe("loadProjectReviewGuidelines", () => {
	it("loads preferred .pi/drykiss review guidelines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "drykiss-guidelines-"));
		try {
			await mkdir(join(dir, ".pi", "drykiss"), { recursive: true });
			await writeFile(
				join(dir, ".pi", "drykiss", "review-guidelines.md"),
				"\nPrefer small focused changes.\n",
			);

			await expect(loadProjectReviewGuidelines(dir)).resolves.toBe(
				"Prefer small focused changes.",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to REVIEW_GUIDELINES.md", async () => {
		const dir = await mkdtemp(join(tmpdir(), "drykiss-guidelines-"));
		try {
			await writeFile(
				join(dir, "REVIEW_GUIDELINES.md"),
				"Use project idioms.\n",
			);

			await expect(loadProjectReviewGuidelines(dir)).resolves.toBe(
				"Use project idioms.",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns null when no guidelines file exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "drykiss-guidelines-"));
		try {
			await expect(loadProjectReviewGuidelines(dir)).resolves.toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("warns and returns null when a guidelines path cannot be read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "drykiss-guidelines-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await mkdir(join(dir, ".pi", "drykiss", "review-guidelines.md"), {
				recursive: true,
			});

			await expect(loadProjectReviewGuidelines(dir)).resolves.toBeNull();
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("Could not read review guidelines"),
			);
		} finally {
			warn.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ── buildSynthesisPrompt ────────────────────────────────────────────────

describe("buildSynthesisPrompt", () => {
	it("returns system and user prompts", async () => {
		const result = await buildSynthesisPrompt("/cwd", [
			{ lens: "simplicity", rawOutput: '[{"file":"a.ts","severity":"high"}]' },
			{
				lens: "deduplication",
				rawOutput: '[{"file":"b.ts","severity":"medium"}]',
			},
		]);
		expect(result.systemPrompt).toContain("Senior Engineer Synthesizer");
		expect(result.systemPrompt).toContain(
			"critical > high > medium > low > nit",
		);
		expect(result.systemPrompt).toContain(
			"Output the final report as a single JSON object",
		);
		expect(result.userPrompt).toContain("SIMPLICITY REVIEWER");
		expect(result.userPrompt).toContain("DEDUPLICATION REVIEWER");
	});

	it("passes activeConstraints to the synthesis composer", async () => {
		await buildSynthesisPrompt(
			"/cwd",
			[{ lens: "simplicity", rawOutput: "[]" }],
			{ activeConstraints: "ignore: [src/legacy/**]" },
		);
		expect(composeSynthesisPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ activeConstraints: "ignore: [src/legacy/**]" }),
		);
	});
});

// ── buildBucketedSynthesisPrompt ─────────────────────────────────────

describe("buildBucketedSynthesisPrompt", () => {
	it("returns system and user prompts", async () => {
		const result = await buildBucketedSynthesisPrompt([
			{ lens: "simplicity", rawOutput: '[{"file":"a.ts","severity":"high"}]' },
			{ lens: "deduplication", rawOutput: "[]" },
		]);
		expect(result.systemPrompt).toContain("Senior Engineer Synthesizer");
		expect(result.userPrompt).toContain("Clustered Reviewer Findings");
	});

	it("clusters duplicate findings across lenses into a single bucket", async () => {
		// Same file, co-located lines, paraphrased text — should
		// cluster into ONE bucket, not two.
		const result = await buildBucketedSynthesisPrompt([
			{
				lens: "simplicity",
				rawOutput:
					'[{ "file":"src/a.ts","line":10,"severity":"medium","category":"X","summary":"Duplicated parsing logic across two modules","detail":"d","suggestion":"s" }]',
			},
			{
				lens: "deduplication",
				rawOutput:
					'[{ "file":"src/a.ts","line":12,"severity":"high","category":"Y","summary":"Duplicated parsing logic across three modules","detail":"d","suggestion":"s" }]',
			},
		]);
		// Bucket count should appear in the "Buckets (N)" header.
		const match = result.userPrompt.match(/## Buckets \((\d+)\)/);
		expect(match).not.toBeNull();
		const bucketCount = Number(match?.[1]);
		expect(bucketCount).toBe(1);
		// The cluster should expose both contributing lenses.
		expect(result.userPrompt).toContain("lenses=");
		expect(result.userPrompt).toContain("simplicity");
		expect(result.userPrompt).toContain("deduplication");
	});

	it("preserves per-lens error notices instead of dropping them silently", async () => {
		const result = await buildBucketedSynthesisPrompt([
			{ lens: "simplicity", rawOutput: "ERROR: model failed" },
			{ lens: "deduplication", rawOutput: "[]" },
		]);
		// The Lens Status section uses display names (KISS for simplicity).
		expect(result.userPrompt).toContain("Lens Status");
		expect(result.userPrompt).toContain("KISS");
		expect(result.userPrompt).toContain("DRY");
		expect(result.userPrompt).toContain("error");
	});

	it("reports lens status as 'ok' when parsing succeeded", async () => {
		const result = await buildBucketedSynthesisPrompt([
			{ lens: "simplicity", rawOutput: "[]" },
		]);
		// KISS is the display name for simplicity.
		expect(result.userPrompt).toMatch(/KISS.*ok/);
	});

	it("falls back gracefully when every lens produced no findings", async () => {
		const result = await buildBucketedSynthesisPrompt([
			{ lens: "simplicity", rawOutput: "[]" },
			{ lens: "deduplication", rawOutput: "[]" },
		]);
		expect(result.userPrompt).toContain("(no findings)");
	});

	it("passes activeConstraints to the synthesis composer", async () => {
		await buildBucketedSynthesisPrompt(
			[{ lens: "simplicity", rawOutput: "[]" }],
			{ activeConstraints: "ignore: [src/legacy/**]" },
		);
		expect(composeSynthesisPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ activeConstraints: "ignore: [src/legacy/**]" }),
		);
	});
});

// ── buildAutoInjectBlock ────────────────────────────────────────────────

describe("buildAutoInjectBlock", () => {
	it("returns block with empty file list when no files", () => {
		const block = buildAutoInjectBlock({ files: [] });
		expect(block).toContain("KISS/DRY Quick Check");
		expect(block).toContain("You edited: ");
	});

	it("lists edited files", () => {
		const block = buildAutoInjectBlock({
			files: [
				{ path: "src/a.ts", language: "TypeScript" },
				{ path: "src/b.ts", language: "TypeScript" },
			],
		});
		expect(block).toContain("src/a.ts, src/b.ts");
		expect(block).toContain("Is the new code as simple as the problem allows?");
		expect(block).toContain("Is knowledge represented once?");
		expect(block).toContain("Do variables/functions reveal intent");
		expect(block).toContain("Are functions focused on one thing?");
		expect(block).toContain("Do they explain WHY, not WHAT?");
		expect(block).toContain("Edge cases");
		expect(block).toContain("Security");
		expect(block).toContain("Resilience");
		expect(block).toContain("Architecture");
		expect(block).toContain("deep module");
	});
});

// ── Prompt loading & seed lifecycle ─────────────────────────────────────

describe("prompt template management", () => {
	describe("getPromptPath", () => {
		it("returns the user-prompt path under the global prompts dir", () => {
			// Override userPromptsDir (in this test only) to return a real-looking path
			vi.mocked(userPromptsDir).mockReturnValue(
				join(require("node:os").homedir(), ".pi", "drykiss", "prompts"),
			);
			const path = getPromptPath("simplicity");
			expect(path).toMatch(/\.pi[/\\]drykiss[/\\]prompts[/\\]simplicity\.md$/);
		});

		it("returns the synthesis path", () => {
			vi.mocked(userPromptsDir).mockReturnValue(
				join(require("node:os").homedir(), ".pi", "drykiss", "prompts"),
			);
			const path = getPromptPath("synthesis");
			expect(path).toMatch(/\.pi[/\\]drykiss[/\\]prompts[/\\]synthesis\.md$/);
		});
	});

	describe("loadLensSystemPrompt", () => {
		it("delegates to composeLensPrompt with no active constraints", async () => {
			await loadLensSystemPrompt("simplicity");
			expect(composeLensPrompt).toHaveBeenCalledWith(
				"simplicity",
				expect.objectContaining({ activeConstraints: undefined }),
			);
		});

		it("passes activeConstraints through to the composer", async () => {
			await loadLensSystemPrompt("simplicity", "disable: [K1]");
			expect(composeLensPrompt).toHaveBeenCalledWith(
				"simplicity",
				expect.objectContaining({ activeConstraints: "disable: [K1]" }),
			);
		});
	});

	describe("loadSynthesisSystemPrompt", () => {
		it("delegates to composeSynthesisPrompt", async () => {
			await loadSynthesisSystemPrompt();
			expect(composeSynthesisPrompt).toHaveBeenCalled();
		});
	});

	/**
	 * The seed and reset functions read from the bundled dir (real `.md` files
	 * shipped in the repo at `src/prompts/`) and write to a real temp user dir.
	 * We do NOT mock `node:fs/promises` for these tests — we use the real FS
	 * so the integration is exercised end-to-end.
	 */
	describe("ensureDefaultPrompts / resetPrompts (real-fs integration)", () => {
		async function withTempUserDir<T>(
			callback: (userDir: string) => Promise<T>,
		): Promise<T> {
			const userDir = await mkdtemp(join(tmpdir(), "drykiss-user-"));
			try {
				return await callback(userDir);
			} finally {
				await rm(userDir, { recursive: true, force: true });
			}
		}

		it("seeds the user dir with all bundled files on first run", async () => {
			await withTempUserDir(async (userDir) => {
				// bundledPromptsDir points to the real `src/prompts/` shipped in the repo
				const bundledDir = join(process.cwd(), "src", "prompts");
				vi.mocked(bundledPromptsDir).mockReturnValue(bundledDir);
				vi.mocked(userPromptsDir).mockReturnValue(userDir);

				await ensureDefaultPrompts("/cwd");

				// 8 lens + 7 shared + 1 sentinel = 16 files
				const entries = await readdir(userDir);
				const sharedEntries = await readdir(join(userDir, "_shared"));
				expect(entries.filter((n) => n.endsWith(".md"))).toHaveLength(8);
				expect(sharedEntries.filter((n) => n.endsWith(".md"))).toHaveLength(7);
				expect(entries.some((n) => n.startsWith(".drykiss-prompt-v"))).toBe(
					true,
				);
			});
		});

		it("does not re-seed when the sentinel is present", async () => {
			await withTempUserDir(async (userDir) => {
				const bundledDir = join(process.cwd(), "src", "prompts");
				vi.mocked(bundledPromptsDir).mockReturnValue(bundledDir);
				vi.mocked(userPromptsDir).mockReturnValue(userDir);

				await ensureDefaultPrompts("/cwd");
				const before = (await readdir(userDir)).sort();

				// Second call: sentinel present → no writes
				await ensureDefaultPrompts("/cwd");
				const after = (await readdir(userDir)).sort();

				expect(after).toEqual(before);
			});
		});

		it("resetPrompts overwrites the user dir with fresh bundled content", async () => {
			await withTempUserDir(async (userDir) => {
				const bundledDir = join(process.cwd(), "src", "prompts");
				vi.mocked(bundledPromptsDir).mockReturnValue(bundledDir);
				vi.mocked(userPromptsDir).mockReturnValue(userDir);

				// First seed
				await ensureDefaultPrompts("/cwd");
				// Corrupt one file
				await writeFile(join(userDir, "simplicity.md"), "CORRUPTED", "utf8");
				const corrupted = await readFile(
					join(userDir, "simplicity.md"),
					"utf8",
				);
				expect(corrupted).toBe("CORRUPTED");

				// Reset restores from bundled
				await resetPrompts();
				const restored = await readFile(join(userDir, "simplicity.md"), "utf8");
				expect(restored).not.toBe("CORRUPTED");
				expect(restored).toContain("Simplicity Auditor");
			});
		});
	});

	describe("commands context", () => {
		it("includes configured commands in the user prompt", async () => {
			vi.mocked(composeLensPrompt).mockResolvedValue("system");
			const result = await buildReviewPrompts(
				"/cwd",
				mockFiles,
				mockDiffs,
				"simplicity",
				{
					commands: { test: "npm test", lint: "npm run lint" },
				},
			);
			expect(result[0].userPrompt).toContain("Test command: `npm test`");
			expect(result[0].userPrompt).toContain("Lint command: `npm run lint`");
		});

		it("omits the commands block when no commands are provided", async () => {
			vi.mocked(composeLensPrompt).mockResolvedValue("system");
			const result = await buildReviewPrompts(
				"/cwd",
				mockFiles,
				mockDiffs,
				"simplicity",
			);
			expect(result[0].userPrompt).not.toContain("Configured Commands");
		});

		it("omits the commands block when commands object is empty", async () => {
			vi.mocked(composeLensPrompt).mockResolvedValue("system");
			const result = await buildReviewPrompts(
				"/cwd",
				mockFiles,
				mockDiffs,
				"simplicity",
				{ commands: {} },
			);
			expect(result[0].userPrompt).not.toContain("Configured Commands");
		});
	});
});
