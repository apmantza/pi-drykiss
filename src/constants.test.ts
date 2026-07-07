import { describe, it, expect } from "vitest";
import {
	getGlobalBaseDir,
	getProjectBaseDir,
	getProjectConfigPath,
	DRYKISS_BASE_DIR,
	CONFIG_FILE,
	LENS_DISPLAY_NAMES,
	LOG_PREFIX,
	assertSafeGitRef,
} from "./constants.js";
import { homedir } from "node:os";

describe("constants", () => {
	it("DRYKISS_BASE_DIR is .pi/drykiss", () => {
		expect(DRYKISS_BASE_DIR).toBe(".pi/drykiss");
	});

	it("CONFIG_FILE is config.json", () => {
		expect(CONFIG_FILE).toBe("config.json");
	});

	it("LOG_PREFIX is [DRYKISS]", () => {
		expect(LOG_PREFIX).toBe("[DRYKISS]");
	});

	it("LENS_DISPLAY_NAMES has entries for all 9 lenses", () => {
		expect(Object.keys(LENS_DISPLAY_NAMES)).toHaveLength(9);
		expect(LENS_DISPLAY_NAMES.simplicity).toBe("KISS");
		expect(LENS_DISPLAY_NAMES.deduplication).toBe("DRY");
		expect(LENS_DISPLAY_NAMES.synthesis).toBe("Synthesis");
		expect(LENS_DISPLAY_NAMES.docs).toBe("Docs");
	});

	describe("assertSafeGitRef", () => {
		it("accepts valid refs", () => {
			expect(() => assertSafeGitRef("main")).not.toThrow();
			expect(() => assertSafeGitRef("HEAD")).not.toThrow();
			expect(() => assertSafeGitRef("abc123")).not.toThrow();
			expect(() => assertSafeGitRef("v1.2.3")).not.toThrow();
		});

		it("rejects refs starting with -", () => {
			expect(() => assertSafeGitRef("-main")).toThrow("cannot start with");
			expect(() => assertSafeGitRef("--flag")).toThrow("cannot start with");
		});

		it("rejects refs with control characters", () => {
			expect(() => assertSafeGitRef("main\x00branch")).toThrow(
				"control characters",
			);
			expect(() => assertSafeGitRef("main\x1fbranch")).toThrow(
				"control characters",
			);
			expect(() => assertSafeGitRef("main\x7f")).toThrow("control characters");
			expect(() => assertSafeGitRef("\x01injection")).toThrow(
				"control characters",
			);
		});
	});
});

describe("getGlobalBaseDir", () => {
	it("returns homedir + .pi/drykiss", () => {
		const result = getGlobalBaseDir();
		expect(result).toContain(homedir());
		expect(result).toContain(".pi");
		expect(result).toContain("drykiss");
	});
});

describe("getProjectBaseDir", () => {
	it("returns cwd + .pi/drykiss", () => {
		const result = getProjectBaseDir("/some/project");
		// Path.join normalises separators — just check components
		expect(result).toContain("some");
		expect(result).toContain("project");
		expect(result).toContain(".pi");
		expect(result).toContain("drykiss");
	});

	it("uses path.join for proper separator", () => {
		// Check components rather than exact path to stay platform-agnostic
		const result = getProjectBaseDir("/other");
		expect(result).toContain(".pi");
		expect(result).toContain("drykiss");
	});
});

describe("getProjectConfigPath", () => {
	it("ends with config.json", () => {
		const result = getProjectConfigPath("/project");
		expect(result).toContain(".pi");
		expect(result).toContain("drykiss");
		expect(result).toContain("config.json");
	});
});
