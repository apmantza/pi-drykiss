import { describe, it, expect } from "vitest";
import { buildAutoInjectBlock } from "./auto-inject.js";

describe("buildAutoInjectBlock", () => {
	it("includes edited file paths in the output", () => {
		const result = buildAutoInjectBlock({
			files: [
				{ path: "src/foo.ts", language: "TypeScript" },
				{ path: "src/bar.ts", language: "TypeScript" },
			],
		});
		expect(result).toContain("src/foo.ts");
		expect(result).toContain("src/bar.ts");
	});

	it("includes all 9 checklist items", () => {
		const result = buildAutoInjectBlock({
			files: [{ path: "src/a.ts", language: "TypeScript" }],
		});
		const expectedItems = [
			"KISS",
			"DRY",
			"Names",
			"Size",
			"Comments",
			"Edge cases",
			"Security",
			"Resilience",
			"Architecture",
		];
		for (const item of expectedItems) {
			expect(result).toContain(item);
		}
	});

	it("handles single file edit", () => {
		const result = buildAutoInjectBlock({
			files: [{ path: "src/single.ts", language: "TypeScript" }],
		});
		expect(result).toContain("src/single.ts");
		expect(result).toContain("KISS");
	});

	it("handles empty file list gracefully", () => {
		const result = buildAutoInjectBlock({ files: [] });
		expect(result).toContain("(no files)");
		expect(result).not.toContain("You edited: .");
		expect(result).toContain("KISS");
		expect(result).toContain("DRY");
	});

	it("handles files with null language", () => {
		const result = buildAutoInjectBlock({
			files: [{ path: "Makefile", language: null }],
		});
		expect(result).toContain("Makefile");
		expect(result).toContain("KISS");
	});
});
