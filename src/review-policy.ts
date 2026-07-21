import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewPathInstruction } from "./config.js";
import { matchesAnyGlob } from "./glob-utils.js";
import type { ChangedFile, ReviewLens, AnyLens } from "./types.js";
import { getNodeErrorCode, LOG_PREFIX } from "./constants.js";

export interface LoadedReviewPolicy {
	readonly markdown: string | null;
	readonly sourcePath?: string;
}

const REVIEW_POLICY_PATHS = [
	[".pi", "drykiss", "REVIEW.md"],
	[".pi", "drykiss", "review-guidelines.md"],
	["REVIEW.md"],
	[".github", "drykiss-review.md"],
	["REVIEW_GUIDELINES.md"],
] as const;

export async function loadProjectReviewPolicy(
	cwd: string,
): Promise<LoadedReviewPolicy> {
	for (const segments of REVIEW_POLICY_PATHS) {
		const path = join(cwd, ...segments);
		try {
			const content = await readFile(path, "utf8");
			const markdown = content.trim();
			if (markdown) return { markdown, sourcePath: path };
		} catch (err) {
			if (getNodeErrorCode(err) !== "ENOENT") {
				console.error(
					`${LOG_PREFIX} Could not read review policy ${path}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	return { markdown: null };
}

export function selectPathInstructions(
	files: readonly ChangedFile[],
	lens: AnyLens,
	instructions: readonly ReviewPathInstruction[] | undefined,
): string[] {
	if (!instructions || instructions.length === 0) return [];
	const paths = files.map((file) => file.path);
	return instructions.flatMap((instruction) =>
		(!instruction.lenses || instruction.lenses.includes(lens)) &&
		paths.some((path) => matchesAnyGlob(path, [instruction.glob]))
			? [instruction.instruction]
			: [],
	);
}
