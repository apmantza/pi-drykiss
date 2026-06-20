import { describe, it, expect } from "vitest";
import { assertPathInRoot } from "./path-utils.js";

describe("assertPathInRoot", () => {
	it("returns the resolved path for a path inside the root", () => {
		const result = assertPathInRoot("src/app.ts", "/project");
		expect(result.replaceAll(/\\/g, "/")).toContain("src/app.ts");
	});

	it("throws for a path outside the root", () => {
		expect(() => assertPathInRoot("../etc/passwd", "/project")).toThrow(
			"resolved outside project root",
		);
	});

	it("throws for an absolute path outside the root", () => {
		expect(() => assertPathInRoot("/etc/passwd", "/project")).toThrow(
			"resolved outside project root",
		);
	});
});
