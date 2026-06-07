import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import {
	saveReview,
	listReviews,
	formatReviewForDisplay,
	saveSessionLog,
	pathToFileLink,
} from "./persist.js";
import type { SynthesisResult } from "./types.js";

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readdir: vi.fn(),
	readFile: vi.fn(),
}));

describe("saveReview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("saves review as JSON", async () => {
		const synthesis: SynthesisResult = {
			findings: [
				{
					file: "src/app.ts",
					line: 42,
					severity: "critical",
					category: "SQL Injection",
					summary: "Raw SQL",
					detail: "detail",
					suggestion: "use params",
					confidence: "confirmed",
				},
			],
			summary: "Top concern: SQL injection",
			verdict: "Request changes",
			criticalCount: 1,
			highCount: 0,
			mediumCount: 0,
			lowCount: 0,
			nitCount: 0,
		};

		const path = await saveReview(["src/app.ts"], synthesis);
		expect(path).toMatch(/\.pi[/\\]drykiss[/\\]reviews[/\\]/);
		expect(path).toContain(".json");
		expect(mkdir).toHaveBeenCalled();

		const written = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
		expect(written.files).toEqual(["src/app.ts"]);
		expect(written.summary).toBe("Top concern: SQL injection");
		expect(written.verdict).toBe("Request changes");
		expect(written.criticalCount).toBe(1);
		expect(written.findings).toHaveLength(1);
	});
});

describe("listReviews", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty array when no reviews exist", async () => {
		vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));
		const reviews = await listReviews();
		expect(reviews).toEqual([]);
	});

	it("parses and sorts review files", async () => {
		vi.mocked(readdir).mockResolvedValue([
			"2026-05-26T10-00-00.json",
			"2026-05-26T12-00-00.json",
		] as any);
		vi.mocked(readFile)
			.mockResolvedValueOnce(
				JSON.stringify({
					timestamp: "2026-05-26T12-00-00",
					files: ["a.ts"],
					findings: [],
					summary: "later",
					verdict: "Approve",
					criticalCount: 0,
					highCount: 0,
					mediumCount: 0,
					lowCount: 0,
					nitCount: 0,
				}),
			)
			.mockResolvedValueOnce(
				JSON.stringify({
					timestamp: "2026-05-26T10-00-00",
					files: ["b.ts"],
					findings: [],
					summary: "earlier",
					verdict: "Approve",
					criticalCount: 0,
					highCount: 0,
					mediumCount: 0,
					lowCount: 0,
					nitCount: 0,
				}),
			);

		const reviews = await listReviews();
		expect(reviews).toHaveLength(2);
		expect(reviews[0].timestamp).toBe("2026-05-26T12-00-00"); // newest first
		expect(reviews[1].timestamp).toBe("2026-05-26T10-00-00");
	});

	it("skips corrupt files", async () => {
		vi.mocked(readdir).mockResolvedValue(["good.json", "bad.json"] as any);
		vi.mocked(readFile)
			.mockResolvedValueOnce(
				JSON.stringify({
					timestamp: "2026-05-26T10-00-00",
					files: [],
					findings: [],
					summary: "",
					verdict: "Approve",
					criticalCount: 0,
					highCount: 0,
					mediumCount: 0,
					lowCount: 0,
					nitCount: 0,
				}),
			)
			.mockResolvedValueOnce("not json");

		const reviews = await listReviews();
		expect(reviews).toHaveLength(1);
	});
});

describe("saveSessionLog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns undefined for an undefined session (no agent session was created)", async () => {
		const result = await saveSessionLog("job-1", "simplicity", undefined);
		expect(result).toBeUndefined();
		expect(mkdir).not.toHaveBeenCalled();
	});

	it("exports a session transcript to ~/.pi/drykiss/sessions/<jobId>-<lens>.jsonl", async () => {
		const session = {
			exportToJsonl: vi.fn().mockReturnValue("/resolved/path.jsonl"),
		};
		const result = await saveSessionLog("abc123def456", "simplicity", session);
		expect(result).toBe("/resolved/path.jsonl");
		expect(session.exportToJsonl).toHaveBeenCalled();
		const callArg = vi.mocked(session.exportToJsonl).mock.calls[0][0] as string;
		expect(callArg).toMatch(/[/\\]\.pi[/\\]drykiss[/\\]sessions[/\\]/);
		expect(callArg).toContain("abc123def456");
		expect(callArg).toContain("simplicity");
		expect(callArg).toMatch(/\.jsonl$/);
	});

	it("returns undefined and warns when exportToJsonl throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const session = {
			exportToJsonl: vi.fn().mockImplementation(() => {
				throw new Error("session is disposed");
			}),
		};
		const result = await saveSessionLog("j1", "simplicity", session);
		expect(result).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to export session log"),
		);
		warnSpy.mockRestore();
	});
});

describe("pathToFileLink", () => {
	it("builds a file:// URL from an absolute path", () => {
		const link = pathToFileLink("/tmp/foo.jsonl");
		expect(link.startsWith("file://")).toBe(true);
		expect(link).toContain("foo.jsonl");
	});

	it("encodes special characters in the path", () => {
		const link = pathToFileLink("/tmp/some dir/file.jsonl");
		// Spaces and other unsafe characters should be percent-encoded.
		expect(link).not.toMatch(/ /);
	});
});

describe("formatReviewForDisplay", () => {
	it("formats a full review as markdown", () => {
		const review = {
			timestamp: "2026-05-26T10-00-00",
			files: ["src/app.ts", "src/utils.ts"],
			findings: [
				{
					file: "src/app.ts",
					line: 42,
					severity: "critical" as const,
					category: "SQL Injection",
					summary: "Raw SQL",
					detail: "User input flows to query",
					suggestion: "Use params",
					confidence: "confirmed" as const,
				},
				{
					file: "src/utils.ts",
					line: 10,
					severity: "high" as const,
					category: "Deep Nesting",
					summary: "4 levels deep",
					detail: "Hard to follow",
					suggestion: "Use guard clauses",
				},
				{
					file: "src/app.ts",
					severity: "medium" as const,
					category: "Magic Number",
					summary: "Magic 42",
					detail: "",
					suggestion: "Use constant",
				},
				{
					file: "src/utils.ts",
					severity: "low" as const,
					category: "Typo",
					summary: "Typo in comment",
					detail: "",
					suggestion: "Fix spelling",
				},
				{
					file: "src/app.ts",
					severity: "nit" as const,
					category: "Formatting",
					summary: "Extra blank line",
					detail: "",
					suggestion: "Remove it",
				},
			],
			summary: "SQL injection is the top concern",
			verdict: "Request changes" as const,
			criticalCount: 1,
			highCount: 1,
			mediumCount: 1,
			lowCount: 1,
			nitCount: 1,
			suppressedCount: 0,
		};

		const md = formatReviewForDisplay(review);
		expect(md).toContain("# KISS/DRY Review Report");
		expect(md).toContain("src/app.ts, src/utils.ts");
		expect(md).toContain("Total findings: 5");
		expect(md).toContain("1 critical, 1 high, 1 medium, 1 low, 1 nit");
		expect(md).toContain("Verdict:** Request changes");
		expect(md).toContain("## Critical (1)");
		expect(md).toContain("SQL Injection");
		expect(md).toContain("src/app.ts:42");
		expect(md).toContain("## High (1)");
		expect(md).toContain("## Medium (1)");
		expect(md).toContain("## Low (1)");
		expect(md).toContain("## Nit (1)");
		expect(md).toContain("**Confidence:** confirmed");
	});

	it("handles empty findings", () => {
		const review = {
			timestamp: "2026-05-26T10-00-00",
			files: ["src/app.ts"],
			findings: [],
			summary: "No issues found",
			verdict: "Approve" as const,
			criticalCount: 0,
			highCount: 0,
			mediumCount: 0,
			lowCount: 0,
			nitCount: 0,
			suppressedCount: 0,
		};

		const md = formatReviewForDisplay(review);
		expect(md).toContain("Total findings: 0");
		expect(md).not.toContain("## Critical");
	});
});
