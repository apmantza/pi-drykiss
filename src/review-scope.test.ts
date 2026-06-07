import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./git-diff.js", () => ({
	parseDiffOutput: vi.fn((stdout: string) => {
		const files: Array<{
			path: string;
			status: string;
			language: string | null;
		}> = [];
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			const parts = line.split("\t");
			const path = parts[parts.length - 1];
			if (path)
				files.push({ path, status: "modified", language: "TypeScript" });
		}
		return files;
	}),
	getAllSourceFiles: vi
		.fn()
		.mockResolvedValue([
			{ path: "src/all.ts", status: "modified", language: "TypeScript" },
		]),
	getChangedFiles: vi
		.fn()
		.mockResolvedValue([
			{ path: "src/a.ts", status: "modified", language: "TypeScript" },
		]),
	getFileContent: vi.fn().mockResolvedValue({
		content: "export const a = 1;",
		lineCount: 1,
		truncated: false,
	}),
	getFileDiff: vi.fn().mockResolvedValue("diff --git a/src/a.ts b/src/a.ts"),
	getProjectIndex: vi
		.fn()
		.mockResolvedValue([{ path: "src/a.ts", exports: ["a"] }]),
}));

vi.mock("./github-pr.js", () => ({
	isGhAvailable: vi.fn().mockResolvedValue(true),
	parsePrUrl: vi.fn().mockReturnValue({ owner: "o", repo: "r", number: 12 }),
	getGitRemote: vi.fn().mockResolvedValue("https://github.com/o/r.git"),
	fetchPrDiff: vi.fn().mockResolvedValue({
		files: [{ path: "src/pr.ts", status: "modified", language: "TypeScript" }],
		diffs: new Map([["src/pr.ts", "diff --git a/src/pr.ts b/src/pr.ts"]]),
		title: "PR title",
		headSha: "abc123",
	}),
	fetchPrFileContents: vi
		.fn()
		.mockResolvedValue(
			new Map([
				[
					"src/pr.ts",
					{ content: "export const pr = 1;", lineCount: 1, truncated: false },
				],
			]),
		),
}));

const { resolveReviewScope } = await import("./review-scope.js");

describe("resolveReviewScope", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function mockPi(stdout = "") {
		return {
			exec: vi.fn().mockResolvedValue({ stdout, stderr: "", code: 0 }),
		} as any;
	}

	it("resolves branch scopes through the shared git path", async () => {
		const { getChangedFiles, getFileDiff, getProjectIndex } = await import(
			"./git-diff.js"
		);
		const pi = mockPi();

		const scope = await resolveReviewScope(
			pi,
			"/repo",
			{ ref: "main" },
			{ contextMode: "full", needsProjectIndex: true },
		);

		expect(scope.mode).toBe("branch");
		expect(scope.label).toBe("branch diff against main");
		expect(scope.files).toHaveLength(1);
		expect(getChangedFiles).toHaveBeenCalledWith(
			pi,
			"/repo",
			expect.objectContaining({ ref: "main", staged: false, all: false }),
		);
		expect(getFileDiff).toHaveBeenCalled();
		expect(getProjectIndex).toHaveBeenCalledWith("/repo");
	});

	it("resolves PR scopes with PR metadata and fetched contents", async () => {
		const { fetchPrDiff, fetchPrFileContents } = await import("./github-pr.js");

		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{ pr: "https://github.com/o/r/pull/12" },
			{ contextMode: "full" },
		);

		expect(scope.mode).toBe("pr");
		expect(scope.label).toBe("o/r#12");
		expect(scope.metadata.title).toBe("PR title");
		expect(scope.contents?.get("src/pr.ts")?.content).toContain("pr");
		expect(fetchPrDiff).toHaveBeenCalledWith("/repo", "o", "r", 12);
		expect(fetchPrFileContents).toHaveBeenCalled();
	});

	it("resolves commit scopes from git show name-status", async () => {
		const pi = mockPi("M\tsrc/commit.ts\n");

		const scope = await resolveReviewScope(
			pi,
			"/repo",
			{ mode: "commit", commit: "HEAD~1" },
			{ contextMode: "diff" },
		);

		expect(scope.mode).toBe("commit");
		expect(scope.files).toEqual([
			{ path: "src/commit.ts", status: "modified", language: "TypeScript" },
		]);
		expect(pi.exec).toHaveBeenCalledWith("git", [
			"-C",
			"/repo",
			"show",
			"--name-status",
			"--format=",
			"HEAD~1",
		]);
	});
});
