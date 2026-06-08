import type { Model, Api } from "@earendil-works/pi-ai";

/**
 * Resolve a user-supplied model hint (CLI --model flag, per-lens config
 * value, etc.) to a concrete `Model<Api>` from the available registry.
 *
 * Match priority:
 *   1. Exact `provider/id` match (case-insensitive)
 *   2. Substring match on model id
 *   3. Substring match on model name
 *
 * Returns `undefined` if nothing matches — the caller is responsible for
 * deciding whether that's an error or a trigger for the interactive
 * picker.
 *
 * This module exists as a leaf so it can be imported from anywhere in
 * the model-selector / free-models / llm chain without creating a
 * circular dependency. (llm.ts and free-models.ts both need this
 * function; if it lived in either of them, the other would have to
 * import it back, completing a cycle.)
 */
export function findModelByHint(
	available: Model<Api>[],
	hint: string,
): Model<Api> | undefined {
	if (!hint) return undefined;
	const lower = hint.toLowerCase();

	// Exact provider/id match
	const exact = available.find(
		(m) => `${m.provider}/${m.id}`.toLowerCase() === lower,
	);
	if (exact) return exact;

	// Partial id match
	const byId = available.find((m) => m.id.toLowerCase().includes(lower));
	if (byId) return byId;

	// Partial name match
	const byName = available.find((m) => m.name.toLowerCase().includes(lower));
	if (byName) return byName;

	return undefined;
}
