import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	runScout,
	applyScoutResult,
	loadScoutDocs,
	type ScoutResult,
	type ScoutStatus,
} from "./scout.js";
import type { ChangedFile } from "./types.js";

vi.mock("./llm.js", () => ({
	resolveModelSmart: vi.fn(),
}));
vi.mock("./subagent-runner.js", () => ({
	runLensSubagent: vi.fn(),
}));

import { resolveModelSmart } from "./llm.js";
import { runLensSubagent } from "./subagent-runner.js";

const mockedResolveModelSmart = vi.mocked(resolveModelSmart);
const mockedRunLensSubagent = vi.mocked(runLensSubagent);
const mockedCallLLM = {
	mockReset: () => mockedRunLensSubagent.mockReset(),
	mockResolvedValue: (response: { text: string; model?: unknown }) =>
		mockedRunLensSubagent.mockResolvedValue({
			lens: "scout",
			text: response.text,
			modelName: "test",
			provider: "test",
			durationMs: 1,
			session: undefined,
		}),
	mockRejectedValue: (error: Error) =>
		mockedRunLensSubagent.mockRejectedValue(error),
};

describe("runScout", () => {
	let tmpDir: string;
	let ctx: ExtensionContext;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "scout-test-"));
		ctx = {
			cwd: tmpDir,
			modelRegistry: {
				getAvailable: () => [],
				getApiKeyAndHeaders: () => ({ ok: false }),
			} as any,
		} as ExtensionContext;
		mockedCallLLM.mockReset();
		mockedResolveModelSmart.mockResolvedValue({
			id: "test",
			name: "test",
			provider: "test",
		} as any);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("returns scout result when LLM returns valid JSON", async () => {
		const allFiles: ChangedFile[] = [
			{ path: "src/index.ts", status: "unchanged", language: "TypeScript" },
			{ path: "src/utils.ts", status: "unchanged", language: "TypeScript" },
		];
		mockedCallLLM.mockResolvedValue({
			text: JSON.stringify({
				summary: "Test project",
				files: [
					{ path: "src/index.ts", reason: "entry point", priority: "high" },
				],
				excludedPatterns: ["*.test.ts"],
				notDone: [],
			}),
			model: { id: "test", name: "test", provider: "test" } as any,
		});

		const result = await runScout(ctx, {
			cwd: tmpDir,
			allFiles,
			maxFiles: 10,
		});

		expect(result).toBeDefined();
		expect(result!.summary).toBe("Test project");
		expect(result!.files).toHaveLength(1);
		expect(result!.files[0].path).toBe("src/index.ts");
		expect(result!.excludedPatterns).toEqual(["*.test.ts"]);
	});

	it("falls back to undefined when LLM returns invalid JSON", async () => {
		const allFiles: ChangedFile[] = [
			{ path: "src/index.ts", status: "unchanged", language: "TypeScript" },
		];
		mockedCallLLM.mockResolvedValue({
			text: "not json",
			model: { id: "test", name: "test", provider: "test" } as any,
		});

		const statuses: ScoutStatus[] = [];
		const result = await runScout(ctx, {
			cwd: tmpDir,
			allFiles,
			maxFiles: 10,
			onStatus: (status) => statuses.push(status),
		});

		expect(result).toBeUndefined();
		expect(statuses.at(-1)).toEqual(
			expect.objectContaining({
				phase: "fallback",
				reason: expect.stringContaining("Invalid scout response:"),
			}),
		);
	});

	it("falls back to undefined when LLM call throws", async () => {
		const allFiles: ChangedFile[] = [
			{ path: "src/index.ts", status: "unchanged", language: "TypeScript" },
		];
		mockedCallLLM.mockRejectedValue(new Error("model unavailable"));

		const result = await runScout(ctx, {
			cwd: tmpDir,
			allFiles,
			maxFiles: 10,
		});

		expect(result).toBeUndefined();
	});

	it("skips unknown file paths returned by the LLM", async () => {
		const allFiles: ChangedFile[] = [
			{ path: "src/index.ts", status: "unchanged", language: "TypeScript" },
		];
		mockedCallLLM.mockResolvedValue({
			text: JSON.stringify({
				summary: "Test project",
				files: [
					{ path: "src/index.ts", reason: "entry point", priority: "high" },
					{
						path: "src/missing.ts",
						reason: "does not exist",
						priority: "high",
					},
				],
				excludedPatterns: [],
				notDone: [],
			}),
			model: { id: "test", name: "test", provider: "test" } as any,
		});

		const result = await runScout(ctx, {
			cwd: tmpDir,
			allFiles,
			maxFiles: 10,
		});

		expect(result).toBeDefined();
		expect(result!.files).toHaveLength(1);
		expect(result!.files[0].path).toBe("src/index.ts");
	});

	it("returns undefined when allFiles is empty", async () => {
		mockedCallLLM.mockResolvedValue({
			text: JSON.stringify({
				summary: "Empty project",
				files: [],
				excludedPatterns: [],
				notDone: [],
			}),
			model: { id: "test", name: "test", provider: "test" } as any,
		});

		const result = await runScout(ctx, {
			cwd: tmpDir,
			allFiles: [],
			maxFiles: 10,
		});

		expect(result).toBeUndefined();
	});
});

describe("applyScoutResult", () => {
	it("selects only files chosen by the scout", () => {
		const allFiles: ChangedFile[] = [
			{ path: "src/index.ts", status: "unchanged", language: "TypeScript" },
			{ path: "src/utils.ts", status: "unchanged", language: "TypeScript" },
			{ path: "src/test.ts", status: "unchanged", language: "TypeScript" },
		];
		const scoutResult: ScoutResult = {
			summary: "test",
			files: [
				{ path: "src/index.ts", reason: "entry", priority: "high" },
				{ path: "src/utils.ts", reason: "helper", priority: "medium" },
			],
			excludedPatterns: [],
			notDone: [],
		};

		const selected = applyScoutResult(allFiles, scoutResult);

		expect(selected).toHaveLength(2);
		expect(selected.map((f) => f.path)).toEqual([
			"src/index.ts",
			"src/utils.ts",
		]);
	});

	it("preserves scout ordering", () => {
		const allFiles: ChangedFile[] = [
			{ path: "src/b.ts", status: "unchanged", language: "TypeScript" },
			{ path: "src/a.ts", status: "unchanged", language: "TypeScript" },
		];
		const scoutResult: ScoutResult = {
			summary: "test",
			files: [
				{ path: "src/a.ts", reason: "first", priority: "high" },
				{ path: "src/b.ts", reason: "second", priority: "medium" },
			],
			excludedPatterns: [],
			notDone: [],
		};

		const selected = applyScoutResult(allFiles, scoutResult);

		expect(selected.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("loadScoutDocs", () => {
	it("reads and truncates docs when present", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-docs-"));
		writeFileSync(join(dir, "README.md"), "# Title\n\n" + "x".repeat(20_000));

		const docs = await loadScoutDocs(dir, ["README.md"]);

		expect(docs.has("README.md")).toBe(true);
		const content = docs.get("README.md")!;
		expect(content.length).toBeLessThan(20_000);
		expect(content).toContain("(truncated for scout budget)");
	});

	it("ignores missing docs silently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-docs-missing-"));
		const docs = await loadScoutDocs(dir, ["README.md", "AGENTS.md"]);

		expect(docs.size).toBe(0);
	});

	it("does not read documentation outside the project root", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-docs-root-"));
		const name = `scout-outside-${Date.now()}.md`;
		const outsidePath = join(dir, "..", name);
		writeFileSync(outsidePath, "should not be read");
		try {
			const docs = await loadScoutDocs(dir, [`../${name}`]);
			expect(docs.size).toBe(0);
		} finally {
			unlinkSync(outsidePath);
		}
	});
});
