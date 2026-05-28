import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	buildReviewPrompts,
	buildSynthesisPrompt,
	buildAutoInjectBlock,
	ensureDefaultPrompts,
	resetPrompts,
	loadLensSystemPrompt,
	getPromptPath,
} from "./prompt-builder.js";
import type { ChangedFile } from "./types.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
}));

const mockFiles: ChangedFile[] = [
	{ path: "src/app.ts", status: "modified", language: "TypeScript" },
	{ path: "src/utils.ts", status: "added", language: "TypeScript" },
];

const mockDiffs = new Map<string, string>([
	["src/app.ts", "@@ -1,2 +1,3 @@\n+console.log('hello')"],
	["src/utils.ts", "@@ -0,0 +1,2 @@\n+export const x = 1"],
]);

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
		expect(prompts).toHaveLength(1);
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
		expect(prompts).toHaveLength(1);
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
		expect(prompts).toHaveLength(1);
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
		expect(prompts).toHaveLength(1);
		expect(prompts[0].lens).toBe("tests");
		expect(prompts[0].systemPrompt).toContain("Test Coverage Auditor");
		expect(prompts[0].systemPrompt).toContain("Given-When-Then");
	});

	it("returns single prompt for security lens", async () => {
		const prompts = await buildReviewPrompts(
			"/cwd",
			mockFiles,
			mockDiffs,
			"security",
		);
		expect(prompts).toHaveLength(1);
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
});

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
});

describe("buildAutoInjectBlock", () => {
	it("returns null when no files", () => {
		const block = buildAutoInjectBlock({ files: [] });
		expect(block).toContain("KISS/DRY Quick Check");
		expect(block).toContain("You edited:");
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

describe("prompt template management", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("getPromptPath returns correct path", () => {
		const path = getPromptPath("/cwd", "simplicity");
		expect(path).toMatch(/\.pi[/\\]drykiss[/\\]prompts[/\\]simplicity\.md$/);
	});

	it("loadLensSystemPrompt loads custom prompt from disk", async () => {
		vi.mocked(readFile).mockResolvedValue("Custom prompt body\n");
		const prompt = await loadLensSystemPrompt("/cwd", "simplicity");
		expect(prompt).toContain("Custom prompt body");
		expect(prompt).toContain("Output findings as a single JSON array");
		expect(readFile).toHaveBeenCalled();
	});

	it("loadLensSystemPrompt falls back to default when file missing", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("file not found"), { code: "ENOENT" as const }),
		);
		const prompt = await loadLensSystemPrompt("/cwd", "simplicity");
		expect(prompt).toContain("Simplicity Auditor");
		expect(prompt).toContain("KISS");
		expect(prompt).toContain("Output findings as a single JSON array");
	});

	it("ensureDefaultPrompts creates missing prompt files", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("file not found"), { code: "ENOENT" as const }),
		);
		await ensureDefaultPrompts("/cwd");
		expect(mkdir).toHaveBeenCalled();
		expect(writeFile).toHaveBeenCalledTimes(8); // 7 lenses + synthesis
	});

	it("ensureDefaultPrompts does not overwrite existing files", async () => {
		vi.mocked(readFile).mockResolvedValue("existing content");
		await ensureDefaultPrompts("/cwd");
		expect(mkdir).toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("resetPrompts overwrites all prompt files", async () => {
		vi.mocked(readFile).mockResolvedValue("existing content");
		await resetPrompts("/cwd");
		expect(mkdir).toHaveBeenCalled();
		expect(writeFile).toHaveBeenCalledTimes(8); // 7 lenses + synthesis
	});
});
