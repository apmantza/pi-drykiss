import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, readFile, writeFile, realpath, open } from "node:fs/promises";
import {
	loadConfig,
	saveConfig,
	getModelForLens,
	setLensModel,
	setDefaultModel,
	loadEffectiveConfig,
	saveProjectConfig,
} from "./config.js";

function parseTestJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch (err) {
		throw new Error(
			`Test fixture wrote invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

vi.mock("node:fs/promises", () => {
	const mockFileHandle = {
		stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
		close: vi.fn().mockResolvedValue(undefined),
	};
	return {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn().mockResolvedValue(undefined),
		realpath: vi.fn(),
		open: vi.fn().mockResolvedValue(mockFileHandle),
	};
});

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(mkdir).mockResolvedValue(undefined);
	vi.mocked(realpath).mockImplementation((p) => Promise.resolve(p as string));
	const handle = {
		stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
		close: vi.fn().mockResolvedValue(undefined),
	};
	vi.mocked(open).mockResolvedValue(handle as any);
});

describe("loadConfig", () => {
	it("returns parsed config when file exists", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ defaultModel: "sonnet", interactive: false }),
		);
		const config = await loadConfig();
		expect(config.defaultModel).toBe("sonnet");
		expect(config.interactive).toBe(false);
	});

	it("returns defaults when file is missing", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("file not found"), { code: "ENOENT" as const }),
		);
		const config = await loadConfig();
		expect(config.defaultModel).toBeUndefined();
		expect(config.interactive).toBe(true);
		expect(config.confirmBeforeRun).toBe(true);
	});

	it("returns defaults when file has invalid JSON", async () => {
		vi.mocked(readFile).mockResolvedValue("not json");
		const config = await loadConfig();
		expect(config.interactive).toBe(true);
	});

	it("returns defaults when top-level JSON is not an object", async () => {
		vi.mocked(readFile).mockResolvedValue('"just a string"');
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = await loadConfig();
		expect(config.defaultModel).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("falls back with a warning on EACCES errors", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("Permission denied"), {
				code: "EACCES" as const,
			}),
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = await loadConfig();
		expect(config.defaultModel).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		expect(
			warnSpy.mock.calls.some((c) => String(c[0]).includes("ignoring")),
		).toBe(true);
		warnSpy.mockRestore();
	});

	it("falls back with a warning on generic errors that are not ENOENT or SyntaxError", async () => {
		vi.mocked(readFile).mockRejectedValue(new Error("Disk full"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = await loadConfig();
		expect(config.defaultModel).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

describe("saveConfig", () => {
	it("writes config to .pi/drykiss/config.json", async () => {
		vi.mocked(writeFile).mockResolvedValue(undefined);
		await saveConfig({ defaultModel: "haiku", interactive: false });
		expect(mkdir).toHaveBeenCalled();
		const mkdirPath = vi.mocked(mkdir).mock.calls[0][0] as string;
		expect(mkdirPath).toMatch(/\.pi[/\\]drykiss$/);
		expect(writeFile).toHaveBeenCalled();
		const written = vi.mocked(writeFile).mock.calls[0][1] as string;
		const parsed = parseTestJson(written) as Record<string, unknown>;
		expect(parsed.defaultModel).toBe("haiku");
		expect(parsed.interactive).toBe(false);
	});
});

describe("getModelForLens", () => {
	it("returns per-lens model when set", () => {
		const config = {
			lensModels: { simplicity: "haiku", deduplication: "sonnet" },
			defaultModel: "opus",
		};
		expect(getModelForLens(config, "simplicity")).toBe("haiku");
		expect(getModelForLens(config, "deduplication")).toBe("sonnet");
	});

	it("falls back to default model", () => {
		const config = { defaultModel: "opus", lensModels: { clarity: "sonnet" } };
		expect(getModelForLens(config, "simplicity")).toBe("opus");
		expect(getModelForLens(config, "synthesis")).toBe("opus");
	});

	it("returns undefined when nothing configured", () => {
		expect(getModelForLens({}, "simplicity")).toBeUndefined();
	});

	it("handles unknown lens gracefully", () => {
		const config = { defaultModel: "opus" };
		expect(getModelForLens(config, "nonexistent" as any)).toBe("opus");
	});
});

describe("setLensModel", () => {
	it("sets per-lens model and preserves existing config", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				defaultModel: "opus",
				lensModels: { simplicity: "haiku" },
			}),
		);
		vi.mocked(writeFile).mockResolvedValue(undefined);
		await setLensModel("clarity", "sonnet");
		const written = parseTestJson(
			vi.mocked(writeFile).mock.calls[0][1] as string,
		) as Record<string, unknown>;
		expect(written.lensModels).toEqual({
			simplicity: "haiku",
			clarity: "sonnet",
		});
		expect(written.defaultModel).toBe("opus");
	});
});

describe("setDefaultModel", () => {
	it("sets default model", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("file not found"), { code: "ENOENT" as const }),
		);
		vi.mocked(writeFile).mockResolvedValue(undefined);
		await setDefaultModel("sonnet");
		const written = parseTestJson(
			vi.mocked(writeFile).mock.calls[0][1] as string,
		) as Record<string, unknown>;
		expect(written.defaultModel).toBe("sonnet");
	});

	it("propagates writeFile errors", async () => {
		vi.mocked(readFile).mockResolvedValue(JSON.stringify({}));
		vi.mocked(writeFile).mockRejectedValue(new Error("Write failed"));
		await expect(setDefaultModel("haiku")).rejects.toThrow("Write failed");
	});
});

describe("loadEffectiveConfig — Phase 2 validation", () => {
	it("returns config without warnings when riskTargeting is absent", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ defaultModel: "sonnet" }),
		);
		const result = await loadEffectiveConfig();
		expect(result.warnings).toEqual([]);
		expect(result.config.defaultModel).toBe("sonnet");
	});

	it("warns on unknown risk codes in disable", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				riskTargeting: {
					disable: ["K1", "NO_SUCH_CODE", "R1"],
				},
			}),
		);
		const result = await loadEffectiveConfig();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("NO_SUCH_CODE");
		expect(result.config.riskTargeting?.disable).toEqual(["K1", "R1"]);
	});

	it("warns when both disable and focus are set", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				riskTargeting: {
					disable: ["K1"],
					focus: ["R1"],
				},
			}),
		);
		const result = await loadEffectiveConfig();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("Both disable and focus");
		expect(result.config.riskTargeting?.disable).toBeUndefined();
		expect(result.config.riskTargeting?.focus).toBeUndefined();
	});

	it("warns on unknown risk codes in severity override", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				riskTargeting: {
					severity: [
						{ riskCode: "K1", to: "low" },
						{ riskCode: "BOGUS", to: "high" },
					],
				},
			}),
		);
		const result = await loadEffectiveConfig();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("BOGUS");
		expect(result.config.riskTargeting?.severity).toHaveLength(1);
	});

	it("warns on invalid severity values in severity override", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				riskTargeting: {
					severity: [{ riskCode: "K1", to: "godlike" }],
				},
			}),
		);
		const result = await loadEffectiveConfig();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("godlike");
		expect(result.config.riskTargeting?.severity).toHaveLength(0);
	});

	it("passes through valid ignore patterns unchanged", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				riskTargeting: {
					ignore: ["src/legacy/**", "tests/e2e/*.spec.ts"],
				},
			}),
		);
		const result = await loadEffectiveConfig();
		expect(result.warnings).toEqual([]);
		expect(result.config.riskTargeting?.ignore).toEqual([
			"src/legacy/**",
			"tests/e2e/*.spec.ts",
		]);
	});

	it("deduplicates overlapping global and project suppressions", async () => {
		vi.mocked(readFile).mockImplementation(async (path) => {
			const p = String(path).replaceAll(/\\/g, "/");
			// Global config lives directly under the drykiss base dir.
			if (p.endsWith(".pi/drykiss/config.json") && !p.includes("/project")) {
				return JSON.stringify({
					suppressions: [
						{ id: "s1", riskCode: "K1", pattern: "src/legacy/**" },
					],
				});
			}
			// Project config path includes the project directory first.
			if (p.includes("/project/.pi/drykiss/config.json")) {
				return JSON.stringify({
					suppressions: [
						{ id: "s1", riskCode: "K1", pattern: "src/legacy/**" },
						{ id: "s2", riskCode: "D1", pattern: "tests/e2e/*.ts" },
					],
				});
			}
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		const result = await loadEffectiveConfig("/project");
		expect(result.config.suppressions).toHaveLength(2);
	});

	describe("saveProjectConfig", () => {
		it("writes project config with suppressions, preserving existing fields", async () => {
			vi.mocked(readFile).mockResolvedValue(
				JSON.stringify({ defaultModel: "sonnet" }),
			);
			vi.mocked(writeFile).mockResolvedValue(undefined);

			await saveProjectConfig("/some/project", {
				suppressions: [
					{
						id: "s1",
						riskCode: "K1",
						pattern: "src/legacy/**",
						reason: "Legacy code",
						addedAt: "2026-01-01",
					},
				],
			});

			expect(mkdir).toHaveBeenCalled();
			const dirArg = vi.mocked(mkdir).mock.calls[0][0] as string;
			expect(dirArg).toContain(".pi");
			expect(dirArg).toContain("drykiss");
			expect(writeFile).toHaveBeenCalledTimes(1);
			const written = parseTestJson(
				vi.mocked(writeFile).mock.calls[0][1] as string,
			) as Record<string, unknown>;
			// Existing field preserved
			expect(written.defaultModel).toBe("sonnet");
			// Suppressions added
			const suppressions = written.suppressions as Array<
				Record<string, unknown>
			>;
			expect(suppressions).toHaveLength(1);
			expect(suppressions[0].id).toBe("s1");
			expect(suppressions[0].riskCode).toBe("K1");
		});

		it("creates project config when no existing file", async () => {
			vi.mocked(readFile).mockRejectedValue(
				Object.assign(new Error("not found"), { code: "ENOENT" as const }),
			);
			vi.mocked(writeFile).mockResolvedValue(undefined);

			await saveProjectConfig("/other/project", {
				suppressions: [],
			});

			expect(writeFile).toHaveBeenCalledTimes(1);
			const written = parseTestJson(
				vi.mocked(writeFile).mock.calls[0][1] as string,
			) as Record<string, unknown>;
			expect(written.suppressions).toEqual([]);
			expect(written.defaultModel).toBeUndefined();
		});

		it("propagates writeFile errors", async () => {
			vi.mocked(readFile).mockRejectedValue(
				Object.assign(new Error("not found"), { code: "ENOENT" as const }),
			);
			vi.mocked(writeFile).mockRejectedValue(new Error("Disk full"));

			await expect(
				saveProjectConfig("/project", { suppressions: [] }),
			).rejects.toThrow("Disk full");
		});
	});
});
