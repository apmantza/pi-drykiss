import { describe, it, expect } from "vitest";
import { parsePrUrl, isPrReference } from "./github-pr.js";

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
		const result = parsePrUrl(
			"42",
			"https://github.com/myorg/myrepo.git",
		);
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
