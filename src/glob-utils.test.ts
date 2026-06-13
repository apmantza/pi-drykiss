import { describe, it, expect } from "vitest";
import { compileGlobMatchers, matchesAnyGlob } from "./glob-utils.js";

describe("matchesAnyGlob", () => {
	it("returns false when patterns are empty", () => {
		expect(matchesAnyGlob("src/foo.ts", [])).toBe(false);
	});

	it("matches a simple wildcard in the same directory", () => {
		expect(matchesAnyGlob("foo.ts", ["*.ts"])).toBe(true);
		expect(matchesAnyGlob("foo.js", ["*.ts"])).toBe(false);
	});

	it("matches double-star directory wildcards", () => {
		expect(matchesAnyGlob("src/deep/nested/foo.ts", ["src/**/*.ts"])).toBe(
			true,
		);
		expect(matchesAnyGlob("lib/foo.ts", ["src/**/*.ts"])).toBe(false);
	});

	it("matches question mark wildcards", () => {
		expect(matchesAnyGlob("src/foo.ts", ["src/f?o.ts"])).toBe(true);
		expect(matchesAnyGlob("src/fooo.ts", ["src/f?o.ts"])).toBe(false);
	});

	it("normalizes windows backslashes", () => {
		expect(matchesAnyGlob("src\\foo\\bar.ts", ["src/**/*.ts"])).toBe(true);
	});

	it("matches exact literal dots", () => {
		expect(matchesAnyGlob("foo.generated.ts", ["*.generated.ts"])).toBe(true);
		expect(matchesAnyGlob("src/foo.generated.ts", ["**/*.generated.ts"])).toBe(
			true,
		);
	});

	it("silently ignores invalid patterns", () => {
		expect(matchesAnyGlob("src/foo.ts", ["[invalid", "**/*.ts"])).toBe(true);
	});
});

describe("compileGlobMatchers", () => {
	it("returns empty array for empty input", () => {
		expect(compileGlobMatchers([])).toHaveLength(0);
	});

	it("returns regexes for valid patterns", () => {
		const matchers = compileGlobMatchers(["**/*.ts", "src/**"]);
		expect(matchers).toHaveLength(2);
		expect(matchers[0].test("src/foo.ts")).toBe(true);
		expect(matchers[1].test("src/nested/file.ts")).toBe(true);
	});
});
