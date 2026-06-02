/**
 * Free-model detection and auto-routing helpers.
 *
 * The detection logic (isFreeModel + detectPricingExposed) is adapted from
 * pi-free (https://github.com/apmantza/pi-free) so pi-drykiss works without
 * requiring pi-free to be installed. See lib/registry.ts in that project
 * for the original implementation.
 *
 * Two-route detection:
 *   - If the provider exposes real pricing (any model has cost > 0), a model
 *     is free if both costs are zero OR its name contains "free".
 *   - If the provider does not expose pricing (all models default to cost 0),
 *     a model is free only if its name contains "free". This avoids marking
 *     freemium/cheap models as free.
 *
 * selectFreeModel wraps the detection into a resolver suitable for
 * auto-routing: it filters the available models down to free ones, then
 * (optionally) narrows the choice to a model matching a free-text scope
 * hint, and finally falls back to any free model.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { findModelByHint } from "./llm.js";

/** Minimal model shape needed for free detection. */
export interface FreeModelShape {
	id: string;
	name: string;
	provider: string;
	cost?: { input: number; output: number };
}

/**
 * Detect if a provider exposes actual per-model pricing.
 *
 * Heuristic: if ANY model has cost > 0, the provider definitely exposes
 * pricing. If all models have cost === 0, pricing is likely defaulted and
 * not actually exposed — fall back to name-based detection.
 */
function detectPricingExposed(allModels: FreeModelShape[]): boolean {
	if (allModels.length === 0) return false;
	return allModels.some(
		(m) => (m.cost?.input ?? 0) > 0 || (m.cost?.output ?? 0) > 0,
	);
}

/**
 * Check if a model is free using adaptive Route A/B logic.
 *
 * @param model - The model to test
 * @param allModels - Optional: all models from the same provider, used to
 *                    detect whether pricing is actually exposed.
 */
export function isFreeModel(
	model: FreeModelShape,
	allModels?: FreeModelShape[],
): boolean {
	let pricingExposed: boolean;
	if (allModels && allModels.length > 0) {
		pricingExposed = detectPricingExposed(allModels);
	} else {
		// No peer models provided — default to trusting the cost field.
		pricingExposed = true;
	}

	if (pricingExposed) {
		const isZeroCost =
			(model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0;
		const hasFreeInName = model.name.toLowerCase().includes("free");
		return isZeroCost || hasFreeInName;
	}

	// Non-pricing-exposed: trust the name only.
	return model.name.toLowerCase().includes("free");
}

/**
 * Group models by provider so isFreeModel can do its per-provider
 * pricing-exposure check.
 */
function groupByProvider(
	models: FreeModelShape[],
): Map<string, FreeModelShape[]> {
	const groups = new Map<string, FreeModelShape[]>();
	for (const m of models) {
		const key = (m.provider ?? "").toLowerCase();
		const list = groups.get(key) ?? [];
		list.push(m);
		groups.set(key, list);
	}
	return groups;
}

/**
 * Filter the available models down to the free ones.
 *
 * Exposed for testing and for callers that want the full free list.
 */
export function getFreeModels(available: FreeModelShape[]): FreeModelShape[] {
	const groups = groupByProvider(available);
	const free: FreeModelShape[] = [];
	for (const peerModels of groups.values()) {
		for (const m of peerModels) {
			if (isFreeModel(m, peerModels)) free.push(m);
		}
	}
	return free;
}

/** A model that has just failed — used to avoid re-picking it. */
export interface ExcludedModel {
	provider: string;
	id: string;
}

function isExcluded(m: FreeModelShape, excluded?: ExcludedModel): boolean {
	if (!excluded) return false;
	return (
		(m.provider ?? "").toLowerCase() === excluded.provider.toLowerCase() &&
		(m.id ?? "").toLowerCase() === excluded.id.toLowerCase()
	);
}

/**
 * Pick a free model to auto-route to.
 *
 * Resolution order:
 *   1. Free models whose id/name matches `scope` (substring match via
 *      findModelByHint). Skips `excluded`.
 *   2. Any free model (skips `excluded`).
 *   3. `undefined` if no free model is available.
 *
 * Returns a real `Model<Api>` (not just the shape) so callers can use it
 * directly. The original `Model<Api>` is found via the registry; if the
 * shape is already a `Model<Api>` (the common case), the same object is
 * returned.
 */
export function selectFreeModel(
	ctx: ExtensionContext,
	scope?: string | string[],
	excluded?: ExcludedModel,
): Model<Api> | undefined {
	const available = ctx.modelRegistry.getAvailable() as FreeModelShape[];
	if (available.length === 0) return undefined;

	const free = getFreeModels(available);
	if (free.length === 0) return undefined;

	const filterExcluded = (ms: FreeModelShape[]): FreeModelShape[] =>
		excluded ? ms.filter((m) => !isExcluded(m, excluded)) : ms;

	// 1. Scope match within the free set. When `scope` is an array, hints
	// are tried in order — the first matching free model wins. Empty
	// strings and whitespace-only hints are skipped so a stray comma in
	// the config doesn't widen the match to anything.
	const hints = normalizeScopeHints(scope);
	if (hints.length > 0) {
		const scoped = filterExcluded(free);
		if (scoped.length > 0) {
			for (const hint of hints) {
				const hit = findModelByHint(scoped as unknown as Model<Api>[], hint);
				if (hit) return hit as unknown as Model<Api>;
			}
		}
	}

	// 2. Any free model (excluding the failed one)
	const candidates = filterExcluded(free);
	if (candidates.length > 0) {
		return candidates[0] as unknown as Model<Api>;
	}

	// 3. All free models are excluded — fall back to the original free list
	// so the caller at least gets *some* model. (Better than surfacing no
	// choice: if the user has only one provider and it errored, the popup
	// will let them see the situation.)
	return free[0] as unknown as Model<Api>;
}

/**
 * Normalize a `modelScope` config value to a clean array of hint strings.
 * - `undefined` / empty / whitespace -> `[]`
 * - Single string -> `[string]` (trimmed)
 * - Array -> filtered to non-empty trimmed entries, preserving order
 *
 * Exported for tests and for callers that want the same parsing rules as
 * `selectFreeModel` without invoking the registry.
 */
export function normalizeScopeHints(
	scope: string | string[] | undefined,
): string[] {
	if (scope === undefined) return [];
	const raw = Array.isArray(scope) ? scope : [scope];
	return raw
		.map((s) => (typeof s === "string" ? s.trim() : ""))
		.filter((s) => s.length > 0);
}
