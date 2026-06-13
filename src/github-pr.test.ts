import { describe, it, expect } from "vitest";
import {
	parsePrUrl,
	isPrReference,
	isValidFilePath,
	decodeBase64Content,
	parseUnifiedDiff,
} from "./github-pr.js";

describe("parsePrUrl", () => {
	it("parses full GitHub URL", () => {
		const result = parsePrUrl("https://github.com/owner/repo/pull/123");
		expect(result).toEqual({ owner: "owner", repo: "repo", number: 123 });
	});

	it("parses URL without protocol", () => {
		const result = parsePrUrl("github.com/owner/repo/pull/456");
		expect(result).toEqual({ owner: "owner", repo: "repo", number: 456 });
	});

	it("parses URL with www", () => {
		const result = parsePrUrl("https://www.github.com/owner/repo/pull/789");
		expect(result).toEqual({ owner: "owner", repo: "repo", number: 789 });
	});

	it("parses shorthand format", () => {
		const result = parsePrUrl("owner/repo#123");
		expect(result).toEqual({ owner: "owner", repo: "repo", number: 123 });
	});

	it("parses just a number with git remote", () => {
		const result = parsePrUrl("42", "https://github.com/myorg/myrepo.git");
		expect(result).toEqual({ owner: "myorg", repo: "myrepo", number: 42 });
	});

	it("parses just a number with SSH remote", () => {
		const result = parsePrUrl("42", "git@github.com:myorg/myrepo.git");
		expect(result).toEqual({ owner: "myorg", repo: "myrepo", number: 42 });
	});

	it("returns null for invalid input", () => {
		expect(parsePrUrl("not a pr")).toBeNull();
		expect(parsePrUrl("owner/repo")).toBeNull();
		expect(parsePrUrl("")).toBeNull();
	});

	it("returns null for number without remote", () => {
		expect(parsePrUrl("42")).toBeNull();
	});

	it("handles trailing slashes", () => {
		const result = parsePrUrl("https://github.com/owner/repo/pull/123/");
		expect(result).toEqual({ owner: "owner", repo: "repo", number: 123 });
	});
});

describe("isPrReference", () => {
	it("detects full GitHub URL", () => {
		expect(isPrReference("https://github.com/owner/repo/pull/123")).toBe(true);
	});

	it("detects shorthand format", () => {
		expect(isPrReference("owner/repo#123")).toBe(true);
	});

	it("detects just a number", () => {
		expect(isPrReference("42")).toBe(true);
	});

	it("rejects non-PR references", () => {
		expect(isPrReference("not a pr")).toBe(false);
		expect(isPrReference("file.ts")).toBe(false);
		expect(isPrReference("--all")).toBe(false);
	});

	it("handles whitespace", () => {
		expect(isPrReference("  42  ")).toBe(true);
		expect(isPrReference("  owner/repo#123  ")).toBe(true);
	});
});

describe("isValidFilePath", () => {
	// Regression: prior to this guard, fetchPrFileContents interpolated
	// `path` directly into a `gh api` URL, allowing a malicious PR diff to
	// include `..` (path traversal) or `?`/`#`/`&`/`=` (URL injection) or
	// newlines (header injection). File paths in a PR come from the PR
	// author, so this is a real attack surface.

	it("accepts normal source files", () => {
		expect(isValidFilePath("src/index.ts")).toBe(true);
		expect(isValidFilePath("README.md")).toBe(true);
		expect(isValidFilePath("a/b/c/d/e.txt")).toBe(true);
	});

	it("accepts files with dots, hyphens, and underscores", () => {
		expect(isValidFilePath("foo.test.ts")).toBe(true);
		expect(isValidFilePath("src/my-component.test.tsx")).toBe(true);
		expect(isValidFilePath("src/foo_bar.ts")).toBe(true);
	});

	it("rejects empty paths", () => {
		expect(isValidFilePath("")).toBe(false);
	});

	it("rejects non-string paths", () => {
		expect(isValidFilePath(null)).toBe(false);
		expect(isValidFilePath(undefined)).toBe(false);
		expect(isValidFilePath(42)).toBe(false);
		expect(isValidFilePath({})).toBe(false);
	});

	it("rejects path-traversal segments", () => {
		expect(isValidFilePath("../etc/passwd")).toBe(false);
		expect(isValidFilePath("src/../../../etc")).toBe(false);
		expect(isValidFilePath("src/./foo")).toBe(false);
	});

	it("rejects URL-structural characters", () => {
		expect(isValidFilePath("foo?bar=baz")).toBe(false);
		expect(isValidFilePath("foo#anchor")).toBe(false);
		expect(isValidFilePath("foo&bar")).toBe(false);
		expect(isValidFilePath("foo=bar")).toBe(false);
	});

	it("rejects control characters (incl. newlines for header injection)", () => {
		expect(isValidFilePath("foo\nbar")).toBe(false);
		expect(isValidFilePath("foo\rbar")).toBe(false);
		expect(isValidFilePath("foo\tbar")).toBe(false);
		expect(isValidFilePath("foo\x00bar")).toBe(false);
	});

	it("rejects absolute paths", () => {
		expect(isValidFilePath("/etc/passwd")).toBe(false);
	});

	it("rejects embedded `//`", () => {
		expect(isValidFilePath("src//foo")).toBe(false);
	});

	it("rejects paths over 4096 characters", () => {
		expect(isValidFilePath("a".repeat(4097))).toBe(false);
		expect(isValidFilePath("a".repeat(4096))).toBe(true);
	});
});

describe("decodeBase64Content", () => {
	// Regression: prior to this helper, fetchPrFileContents did the cleanup
	// inline and rejected multi-line base64 (some encoders insert newlines
	// every 76 chars) and rejected empty files (legitimate for new files).
	// This test pins the new behavior.

	it("decodes plain base64", () => {
		expect(decodeBase64Content("SGVsbG8=")).toBe("Hello");
	});

	it("decodes multi-line base64 (whitespace stripped first)", () => {
		// "Hello, world!" = "SGVsbG8sIHdvcmxkIQ==", split with newlines
		const multiLine = "SGVs\nbG8s\nIHdv\ncmxk\nIQ==";
		expect(decodeBase64Content(multiLine)).toBe("Hello, world!");
	});

	it("decodes base64 with mixed whitespace (spaces, tabs, newlines)", () => {
		expect(decodeBase64Content("SGVs bG8s\tIHdv\r\ncmxk IQ==")).toBe(
			"Hello, world!",
		);
	});

	it("returns empty string for empty input (new files)", () => {
		// Regression: prior code rejected empty responses because the regex
		// required length > 0, but a brand-new empty file IS a valid response.
		expect(decodeBase64Content("")).toBe("");
	});

	it("returns null for non-base64 input (e.g. JSON error from API)", () => {
		// API error responses look like JSON, not base64. We must not treat
		// them as content — the caller logs and skips the file.
		expect(decodeBase64Content('{"message":"Not Found"}')).toBeNull();
	});

	it("returns null for partially-valid base64 (mixed with garbage)", () => {
		// If any character in the cleaned input isn't valid base64, refuse
		// the whole thing. Better to log+skip than to silently decode
		// garbage.
		expect(decodeBase64Content("SGVsbG8=garbage!")).toBeNull();
		expect(decodeBase64Content("SGVsbG8={not-base64}")).toBeNull();
	});

	it("decodes a larger realistic payload (multi-line source file)", () => {
		// A few lines of TypeScript, base64-encoded with newlines
		const src = "export const x = 1;\nexport const y = 2;\n";
		const b64 = Buffer.from(src, "utf-8").toString("base64");
		const wrapped = b64.match(/.{1,20}/g)!.join("\n");
		expect(decodeBase64Content(wrapped)).toBe(src);
	});
});

describe("parseUnifiedDiff", () => {
	it("parses a modified file", () => {
		const diff = `diff --git a/src/foo.ts b/src/foo.ts\nindex 1234..5678 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new`;
		const result = parseUnifiedDiff(diff);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]).toMatchObject({
			path: "src/foo.ts",
			status: "modified",
		});
		expect(result.diffs.get("src/foo.ts")).toContain("diff --git");
	});

	it("parses added and deleted files", () => {
		const diff = `diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+hello\ndiff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-goodbye`;
		const result = parseUnifiedDiff(diff);
		expect(result.files).toHaveLength(2);
		expect(result.files[0].status).toBe("added");
		expect(result.files[1].status).toBe("deleted");
	});
});
