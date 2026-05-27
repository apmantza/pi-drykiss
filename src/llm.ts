import { complete } from "@earendil-works/pi-ai";
import type { Context, Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, getModelForLens, saveConfig } from "./config.js";
import { selectModel, isQuotaError, isAuthError } from "./model-selector.js";

export interface LLMOptions {
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly signal?: AbortSignal;
}

/**
 * Resolve a model using this priority:
 * 1. Explicit hint (CLI --model flag)
 * 2. Per-lens config (e.g. lensModels.simplicity)
 * 3. Default config (defaultModel)
 * 4. Interactive selector (if interactive: true and hasUI)
 * 5. Fallback to first available model
 */
export async function resolveModelSmart(
	ctx: ExtensionContext,
	cwd: string,
	hint?: string,
	lens?: string,
): Promise<Model<Api> | undefined> {
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	// 1. Explicit hint
	if (hint) {
		const m = findModelByHint(available, hint);
		if (m) return m;
	}

	// 2-3. Config
	const config = await loadConfig(cwd);
	const configHint = getModelForLens(config, lens);
	if (configHint) {
		const m = findModelByHint(available, configHint);
		if (m) return m;
	}

	// 4. Interactive selector
	if (config.interactive !== false && ctx.hasUI) {
		const selected = await selectModel(
			ctx,
			"Select Model",
			lens
				? `Choose a model for the ${lens} review`
				: "Choose a model for the review",
		);
		if (selected) {
			// Save to config so they don't have to pick again
			if (lens) {
				config.lensModels = {
					...config.lensModels,
					[lens]: `${selected.provider}/${selected.id}`,
				};
			} else {
				config.defaultModel = `${selected.provider}/${selected.id}`;
			}
			await saveConfig(cwd, config);
			ctx.ui.notify(
				`Saved ${selected.name} as default for ${lens ?? "all reviews"}.`,
				"info",
			);
			return selected;
		}
	}

	// 5. Fallback
	return available[0];
}

export function findModelByHint(
	available: Model<Api>[],
	hint: string,
): Model<Api> | undefined {
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

/**
 * Call the LLM directly. On quota/auth errors, prompt the user to pick
 * a different model and retry once.
 */
export async function callLLM(
	ctx: ExtensionContext,
	cwd: string,
	systemPrompt: string,
	userPrompt: string,
	options?: LLMOptions,
	lens?: string,
): Promise<{ text: string; model: Model<Api> }> {
	let model = await resolveModelSmart(ctx, cwd, undefined, lens);
	if (!model) {
		throw new Error("No model available. Configure an API key with /login.");
	}

	const attempt = async (): Promise<{ text: string; model: Model<Api> }> => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model!);
		if (!auth.ok) {
			throw new Error(
				`No API key for ${model!.provider}/${model!.id}: ${auth.error}`,
			);
		}

		const context: Context = {
			systemPrompt,
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
		};

		const response = await complete(model!, context, {
			temperature: options?.temperature ?? 0.2,
			maxTokens: options?.maxTokens ?? 4000,
			signal: options?.signal,
		});

		const parts = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text);

		return { text: parts.join(""), model: model! };
	};

	try {
		return await attempt();
	} catch (err: any) {
		if (isQuotaError(err) || isAuthError(err)) {
			if (!ctx.hasUI) throw err;

			const selected = await selectModel(
				ctx,
				"Model Error",
				`${model.name} failed: ${err.message}\n\nChoose a different model:`,
			);
			if (!selected) throw err;

			model = selected;
			ctx.ui.notify(`Retrying with ${model.name}...`, "info");
			return await attempt();
		}
		throw err;
	}
}
