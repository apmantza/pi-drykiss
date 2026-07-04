/**
 * prompt-composer.ts — Composes a lens system prompt from shared fragments + the per-lens body.
 *
 * Composition order (lens):
 *   1. iron-law.md
 *   2. <lens>.md
 *   3. active-constraints.md  (only when `activeConstraints` is non-empty)
 *   4. json-output.md
 *   5. grounding-rules.md
 *   6. kiss-dry-checklist.md
 *
 * Composition order (synthesis):
 *   1. iron-law.md
 *   2. synthesis.md
 *   3. active-constraints.md  (only when `activeConstraints` is non-empty)
 *   4. json-output-synthesis.md
 *   5. grounding-rules-synthesis.md
 *
 * Substitutions:
 *   - `{{active_constraints}}` in `active-constraints.md` is replaced with the runtime constraint text.
 *
 * All prompt text lives in `.md` files; this module is pure composition.
 */

import { loadPromptBody } from "./prompt-loader.js";
import type { ReviewLens } from "./types.js";

export type LensName = Exclude<ReviewLens, "all"> | "synthesis";

export interface ComposeOptions {
	/**
	 * If provided and non-empty, the `active-constraints.md` fragment is included
	 * with the `{{active_constraints}}` placeholder substituted with this text.
	 */
	readonly activeConstraints?: string;
}

/** Substitute `{{key}}` placeholders in a template string. */
function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		const v = vars[key];
		return v ?? `{{${key}}}`;
	});
}

/**
 * Compose a lens system prompt.
 */
export async function composeLensPrompt(
	lens: Exclude<ReviewLens, "all">,
	options: ComposeOptions = {},
): Promise<string> {
	const [ironLaw, lensBody, jsonOutput, grounding, kissDry, activeTemplate] =
		await Promise.all([
			loadPromptBody("iron-law", "shared"),
			loadPromptBody(lens, "lens"),
			loadPromptBody("json-output", "shared"),
			loadPromptBody("grounding-rules", "shared"),
			loadPromptBody("kiss-dry-checklist", "shared"),
			options.activeConstraints
				? loadPromptBody("active-constraints", "shared")
				: Promise.resolve(""),
		]);

	const sections: string[] = [ironLaw, lensBody];
	if (activeTemplate && options.activeConstraints) {
		sections.push(
			substitute(activeTemplate, {
				active_constraints: options.activeConstraints,
			}),
		);
	}
	sections.push(jsonOutput, grounding, kissDry);

	return sections.filter(Boolean).join("\n\n");
}

/**
 * Compose the synthesis system prompt.
 */
export async function composeSynthesisPrompt(
	options: ComposeOptions = {},
): Promise<string> {
	const [ironLaw, synthesisBody, jsonOutput, grounding, activeTemplate] =
		await Promise.all([
			loadPromptBody("iron-law", "shared"),
			loadPromptBody("synthesis", "lens"),
			loadPromptBody("json-output-synthesis", "shared"),
			loadPromptBody("grounding-rules-synthesis", "shared"),
			options.activeConstraints
				? loadPromptBody("active-constraints", "shared")
				: Promise.resolve(""),
		]);

	const sections: string[] = [ironLaw, synthesisBody];
	if (activeTemplate && options.activeConstraints) {
		sections.push(
			substitute(activeTemplate, {
				active_constraints: options.activeConstraints,
			}),
		);
	}
	sections.push(jsonOutput, grounding);

	return sections.filter(Boolean).join("\n\n");
}
