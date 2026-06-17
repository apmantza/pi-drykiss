import { describe, expect, it, vi } from "vitest";
import { getDefaultBranch, resolveSmartDefault } from "./smart-default.js";

function makePiExec(results: Array<{ code: number; stdout: string }>) {
	return {
		exec: vi.fn().mockImplementation(async () => {
			const next = results.shift();
			return next ?? { code: 1, stdout: "" };
		}),
	} as any;
}

describe("resolveSmartDefault", () => {
	it("reviews uncommitted changes when the working tree is dirty", async () => {
		const pi = makePiExec([{ code: 0, stdout: " M src/a.ts\n" }]);

		await expect(resolveSmartDefault(pi)).resolves.toEqual({
			ref: "HEAD",
			label: "uncommitted changes",
		});
		expect(pi.exec).toHaveBeenCalledTimes(1);
	});

	it("reviews branch diff against default branch on a clean feature branch", async () => {
		const pi = makePiExec([
			{ code: 0, stdout: "" },
			{ code: 0, stdout: "feature/review\n" },
			{ code: 0, stdout: "origin/master\n" },
		]);

		await expect(resolveSmartDefault(pi)).resolves.toEqual({
			ref: "master",
			label: "branch diff against master",
		});
	});

	it("reviews local changes on the default branch", async () => {
		const pi = makePiExec([
			{ code: 0, stdout: "" },
			{ code: 0, stdout: "main\n" },
			{ code: 0, stdout: "origin/main\n" },
		]);

		await expect(resolveSmartDefault(pi)).resolves.toEqual({
			ref: "HEAD",
			label: "local changes",
		});
	});
});

describe("getDefaultBranch", () => {
	it("falls back to branch list when origin HEAD is unavailable", async () => {
		const pi = makePiExec([
			{ code: 1, stdout: "" },
			{ code: 0, stdout: "feature\nmain\n" },
		]);

		await expect(getDefaultBranch(pi)).resolves.toBe("main");
	});

	it("falls back to main when git commands fail", async () => {
		const pi = makePiExec([
			{ code: 1, stdout: "" },
			{ code: 1, stdout: "" },
		]);

		await expect(getDefaultBranch(pi)).resolves.toBe("main");
	});
});
