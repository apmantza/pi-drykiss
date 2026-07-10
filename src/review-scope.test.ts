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
			undefined,
		);
		expect(getFileDiff).toHaveBeenCalled();
		expect(getProjectIndex).toHaveBeenCalledWith(
			"/repo",
			200,
			undefined,
			undefined,
		);
	});

	it("records unexpected diff collection failures without aborting the scope", async () => {
		const { getFileDiff } = await import("./git-diff.js");
		vi.mocked(getFileDiff).mockRejectedValueOnce(new Error("git unavailable"));

		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{},
			{ contextMode: "diff" },
		);

		expect(scope.diffs.get("src/a.ts")).toBe("(diff unavailable)");
		expect(scope.preparationErrors).toEqual([
			"Failed to get diff for src/a.ts: git unavailable",
		]);
	});

	it("records unexpected file-content collection failures without aborting the scope", async () => {
		const { getFileContent } = await import("./git-diff.js");
		vi.mocked(getFileContent).mockRejectedValueOnce(
			new Error("disk unavailable"),
		);

		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{},
			{ contextMode: "full" },
		);

		expect(scope.contents).toEqual(new Map());
		expect(scope.preparationErrors).toEqual([
			"Failed to load content for src/a.ts: disk unavailable",
		]);
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
		expect(scope.preparationErrors).toEqual([]);
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
		expect(scope.preparationErrors).toEqual([]);
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

	it("records commit-scope content failures without aborting the scope", async () => {
		const { getFileContent } = await import("./git-diff.js");
		vi.mocked(getFileContent).mockRejectedValueOnce(
			new Error("disk unavailable"),
		);

		const scope = await resolveReviewScope(
			mockPi("M\tsrc/commit.ts\n"),
			"/repo",
			{ mode: "commit", commit: "HEAD~1" },
			{ contextMode: "full" },
		);

		expect(scope.contents).toEqual(new Map());
		expect(scope.preparationErrors).toEqual([
			"Failed to load content for src/commit.ts: disk unavailable",
		]);
	});

	it("rejects commit refs that look like git options", async () => {
		const pi = mockPi("M\tsrc/commit.ts\n");

		await expect(
			resolveReviewScope(
				pi,
				"/repo",
				{ mode: "commit", commit: "--output=/tmp/evil" },
				{ contextMode: "diff" },
			),
		).rejects.toThrow("Invalid git ref");

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("resolves local scope by default when no request params", async () => {
		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{},
			{ contextMode: "full" },
		);
		expect(scope.mode).toBe("local");
		expect(scope.label).toBe("local changes");
		expect(scope.files).toHaveLength(1);
		expect(scope.files[0].path).toBe("src/a.ts");
		expect(scope.diffs.has("src/a.ts")).toBe(true);
		expect(scope.contents?.get("src/a.ts")?.content).toContain("a");
	});

	it("applies excludes after discovery while force-includes win", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValueOnce([
			{ path: "src/keep.ts", status: "modified", language: "TypeScript" },
			{
				path: "src/generated/keep.ts",
				status: "modified",
				language: "TypeScript",
			},
			{
				path: "src/generated/drop.ts",
				status: "modified",
				language: "TypeScript",
			},
		]);

		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{},
			{
				contextMode: "diff",
				pathFilters: {
					exclude: ["src/generated/**"],
					forceInclude: ["src/generated/keep.ts"],
				},
			},
		);

		expect(scope.files.map((file) => file.path)).toEqual([
			"src/keep.ts",
			"src/generated/keep.ts",
		]);
	});

	it("does not filter explicit file scopes", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		vi.mocked(getChangedFiles).mockResolvedValueOnce([
			{
				path: "src/generated/drop.ts",
				status: "modified",
				language: "TypeScript",
			},
		]);
		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{ files: ["src/generated/drop.ts"] },
			{
				contextMode: "diff",
				pathFilters: { exclude: ["src/generated/**"] },
			},
		);

		expect(scope.files.map((file) => file.path)).toEqual([
			"src/generated/drop.ts",
		]);
	});

	it("resolves staged scope when staged=true", async () => {
		const { getChangedFiles } = await import("./git-diff.js");
		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{ staged: true },
			{ contextMode: "diff" },
		);
		expect(scope.mode).toBe("staged");
		expect(scope.label).toBe("staged changes");
		expect(getChangedFiles).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ staged: true }),
			undefined,
		);
		// contextMode=diff so contents should be undefined
		expect(scope.contents).toBeUndefined();
	});

	it("resolves files scope with explicit file list", async () => {
		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{ files: ["src/foo.ts", "src/bar.ts"] },
			{ contextMode: "full" },
		);
		expect(scope.mode).toBe("files");
		expect(scope.label).toBe("explicit files");
		expect(scope.options.files).toEqual(["src/foo.ts", "src/bar.ts"]);
	});

	it("resolves full scope for all files", async () => {
		const { getAllSourceFiles } = await import("./git-diff.js");
		const scope = await resolveReviewScope(
			mockPi(),
			"/repo",
			{ all: true },
			{ contextMode: "full", needsProjectIndex: true },
		);
		expect(scope.mode).toBe("full");
		expect(scope.label).toBe("full codebase");
		expect(getAllSourceFiles).toHaveBeenCalledWith("/repo", undefined);
	});
});
