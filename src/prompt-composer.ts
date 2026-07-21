/**
 * prompt-composer.ts — Composes a lens system prompt from shared fragments + the per-lens body.
 *
 * Composition order (lens):
 *   1. iron-law.md
 *   2. <lens>.md
 *   3. active-constraints.md  (only when `activeConstraints` is non-empty)
 *   4. json-output.md
 *   5. grounding-rules.md  (includes the Quick Self-Check checklist)
 *
 * Composition order (synthesis):
 *   1. iron-law.md
 *   2. synthesis.md
 *   3. active-constraints.md  (only when `activeConstraints` is non-empty)
 *   4. json-output-synthesis.md
 *   5. grounding-rules.md  (shared lens grounding)
 *   6. grounding-rules-synthesis.md  (synthesis-only final-filter rules)
 *
 * Substitutions:
 *   - `{{active_constraints}}` in `active-constraints.md` is replaced with the runtime constraint text.
 *
 * All prompt text lives in `.md` files; this module is pure composition.
 */

import { loadPromptBody } from "./prompt-loader.js";
import type { ReviewLens, AnyLens } from "./types.js";
import { logAutoreviewEvent } from "./logger.js";

export type LensName = Exclude<ReviewLens, "all"> | "synthesis";

export interface ComposeOptions {
	/**
	 * If provided and non-empty, the `active-constraints.md` fragment is included
	 * with the `{{active_constraints}}` placeholder substituted with this text.
	 */
	readonly activeConstraints?: string;
	/**
	 * When true, the `fix-mode.md` shared fragment is appended to the lens
	 * system prompt, instructing the lens to include a concrete `fix` field
	 * in every finding it emits.
	 */
	readonly fixMode?: boolean;
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
 * Accepts both built-in lenses (`Exclude<ReviewLens, "all">`) and custom
 * lenses discovered from the user's prompts directory (`AnyLens`).
 * Custom lenses receive the same shared fragments (iron-law, json-output,
 * grounding-rules) as built-in lenses so their output format is consistent.
 */
export async function composeLensPrompt(
	lens: AnyLens,
	options: ComposeOptions = {},
): Promise<string> {
	const [ironLaw, lensBody, jsonOutput, grounding, activeTemplate, fixModeFragment] =
		await Promise.all([
			loadPromptBody("iron-law", "shared"),
			loadPromptBody(lens, "lens"),
			loadPromptBody("json-output", "shared"),
			loadPromptBody("grounding-rules", "shared"),
			options.activeConstraints
				? loadPromptBody("active-constraints", "shared")
				: Promise.resolve(""),
			options.fixMode
				? loadPromptBody("fix-mode", "shared")
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
	sections.push(jsonOutput, grounding);
	if (fixModeFragment) sections.push(fixModeFragment);
	const composed = sections.filter(Boolean).join("\n\n");
	logAutoreviewEvent("prompt.composed", {
		kind: "lens",
		name: lens,
		chars: composed.length,
		fixMode: options.fixMode === true,
	});
	return composed;
}

/**
 * Compose the synthesis system prompt.
 */
export async function composeSynthesisPrompt(
	options: ComposeOptions = {},
): Promise<string> {
	const [
		ironLaw,
		synthesisBody,
		jsonOutput,
		grounding,
		synthesisGrounding,
		activeTemplate,
	] = await Promise.all([
		loadPromptBody("iron-law", "shared"),
		loadPromptBody("synthesis", "lens"),
		loadPromptBody("json-output-synthesis", "shared"),
		loadPromptBody("grounding-rules", "shared"),
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
	sections.push(jsonOutput, grounding, synthesisGrounding);
	const composed = sections.filter(Boolean).join("\n\n");
	logAutoreviewEvent("prompt.composed", {
		kind: "synthesis",
		name: "synthesis",
		chars: composed.length,
	});
	return composed;
}
