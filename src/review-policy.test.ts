import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadProjectReviewPolicy,
	selectPathInstructions,
} from "./review-policy.js";
import type { ChangedFile } from "./types.js";

describe("loadProjectReviewPolicy", () => {
	it("uses REVIEW.md ahead of legacy guideline files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "drykiss-policy-"));
		try {
			await writeFile(join(dir, "REVIEW.md"), "Preferred policy");
			await writeFile(join(dir, "REVIEW_GUIDELINES.md"), "Legacy policy");

			const policy = await loadProjectReviewPolicy(dir);
			expect(policy.markdown).toBe("Preferred policy");
			expect(policy.sourcePath).toBe(join(dir, "REVIEW.md"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("uses the project-local policy before repository policies", async () => {
		const dir = await mkdtemp(join(tmpdir(), "drykiss-policy-"));
		try {
			await mkdir(join(dir, ".pi", "drykiss"), { recursive: true });
			await writeFile(join(dir, ".pi", "drykiss", "REVIEW.md"), "Local policy");
			await writeFile(join(dir, "REVIEW.md"), "Repository policy");

			await expect(loadProjectReviewPolicy(dir)).resolves.toMatchObject({
				markdown: "Local policy",
				sourcePath: join(dir, ".pi", "drykiss", "REVIEW.md"),
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("selectPathInstructions", () => {
	const files = [
		{ path: "src/auth/session.ts", status: "modified", language: "TypeScript" },
	] satisfies ChangedFile[];

	it("selects only matching paths and lenses", () => {
		const instructions = [
			{
				glob: "src/auth/**",
				lenses: ["security"] as const,
				instruction: "Check authorization.",
			},
			{
				glob: "docs/**",
				instruction: "Check examples.",
			},
		];

		expect(selectPathInstructions(files, "security", instructions)).toEqual([
			"Check authorization.",
		]);
		expect(selectPathInstructions(files, "clarity", instructions)).toEqual([]);
	});
});
