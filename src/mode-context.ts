/**
 * mode-context.ts — Maps a review mode to a "posture" and loads the
 * matching per-posture context block injected into the lens USER prompt.
 *
 * Why posture, not per-mode prompt files: the lens METHODOLOGY (the `.md`
 * under `src/prompts/<lens>.md`) is mode-agnostic — KISS is KISS whether
 * the target is a PR or a full-codebase scan. What changes by mode is the
 * FRAMING: is the reviewer gating a proposed change, or auditing an
 * existing codebase? That framing is per-review context, so it belongs in
 * the user prompt (next to the diff), not baked into the reusable system
 * prompt. See `prompt-architecture.md`.
 *
 * This fixes a latent correctness issue: several lens prompts (e.g.
 * `simplicity.md`'s "Surgical Change Check") assume a diff exists. In
 * `full` mode there is no coherent per-file diff to gate, so asking the
 * lens to distinguish "diff-introduced" from "pre-existing" is meaningless.
 * The audit-posture block tells the lens to skip that check.
 *
 * All prompt text lives in `.md` files; this module is pure mapping +
 * file loading + placeholder substitution. No prompt strings here.
 */
import { loadPromptBody } from "./prompt-loader.js";
import { LOG_PREFIX } from "./constants.js";

export type ReviewPosture = "proposed" | "audit";

/** Shared-fragment filenames (without `.md`) for each posture. */
export const MODE_CONTEXT_FRAGMENT_NAMES: Record<ReviewPosture, string> = {
	proposed: "mode-context-proposed",
	audit: "mode-context-audit",
};

/**
 * Map a review mode to a posture.
 *
 * `full` (whole-codebase scan) is the only mode with no coherent per-file
 * diff to gate — it is an audit. Every other mode (local, staged, branch,
 * commit, pr, files) centers on a change set, so it is a proposed change.
 * Unknown / undefined defaults to `proposed` to preserve historical
 * behavior: the lens prompts were written assuming a diff exists.
 */
export function modeToPosture(mode: string | undefined): ReviewPosture {
	return mode === "full" ? "audit" : "proposed";
}

function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		const v = vars[key];
		return v != null ? v : `{{${key}}}`;
	});
}

/**
 * Load and render the posture-specific context block for the lens user
 * prompt. Returns `""` when the fragment is missing, empty, or cannot be
 * read — fail-open so a missing fragment never breaks a review.
 */
export async function loadModeContextBlock(
	posture: ReviewPosture,
	scopeLabel?: string,
): Promise<string> {
	const name = MODE_CONTEXT_FRAGMENT_NAMES[posture];
	let body: string;
	try {
		body = await loadPromptBody(name, "shared");
	} catch (err) {
		console.warn(
			`${LOG_PREFIX} Could not load mode context fragment ${name}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return "";
	}
	if (!body || !body.trim()) return "";
	return substitute(body, {
		posture,
		scope_label: scopeLabel ?? "",
	}).trim();
}
