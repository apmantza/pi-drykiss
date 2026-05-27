/**
 * Subagent runner — spawns each review lens as an in-process Pi agent session
 * via createAgentSession. Each subagent is a visible child session that the
 * user can see in Pi's UI.
 *
 * Pattern adapted from: https://github.com/vigolium/piolium
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	getAgentDir,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, getModelForLens, saveConfig } from "./config.js";
import { selectModel } from "./model-selector.js";
import { findModelByHint } from "./llm.js";
import type { ReviewLens } from "./types.js";

export interface SubagentResult {
	lens: string;
	text: string;
	modelName: string;
	durationMs: number;
	errorMessage?: string;
}

/**
 * Resolve a model for a lens, sequentially and without UI clashes.
 * Uses config first, then falls back to interactive selection.
 */
export async function resolveModel(
	ctx: ExtensionContext,
	cwd: string,
	lens: string,
): Promise<Model<Api>> {
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		throw new Error("No models available. Configure an API key with /login.");
	}

	// 1. Check per-lens config
	const config = await loadConfig(cwd);
	const configHint = getModelForLens(config, lens);
	if (configHint) {
		const m = findModelByHint(available, configHint);
		if (m) return m;
	}

	// 2. Interactive selection (serial — only one at a time)
	if (config.interactive !== false && ctx.hasUI) {
		const selected = await selectModel(
			ctx,
			"Select Review Model",
			`Choose a model for the **${lens}** review lens.`,
		);
		if (selected) {
			// Save to config so they don't have to pick again
			config.lensModels = {
				...config.lensModels,
				[lens]: `${selected.provider}/${selected.id}`,
			};
			await saveConfig(cwd, config);
			ctx.ui.notify(
				`Saved ${selected.name} as default for ${lens} review.`,
				"info",
			);
			return selected;
		}
	}

	// 3. Fallback
	return available[0];
}

/**
 * Resolve models for all lenses. Does interactive selection sequentially
 * first, then returns a map of lens → model for parallel execution.
 */
export async function resolveAllModels(
	ctx: ExtensionContext,
	cwd: string,
	lenses: ReviewLens[],
): Promise<Map<ReviewLens, Model<Api>>> {
	const resolved = new Map<ReviewLens, Model<Api>>();
	for (const lens of lenses) {
		resolved.set(lens, await resolveModel(ctx, cwd, lens));
	}
	return resolved;
}

/**
 * Spawn a single lens review as a Pi subagent.
 */
export async function runLensSubagent(
	ctx: ExtensionContext,
	cwd: string,
	model: Model<Api>,
	systemPrompt: string,
	userPrompt: string,
	lens: string,
): Promise<SubagentResult> {
	const start = Date.now();

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		systemPrompt,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir: getAgentDir(),
		model,
		tools: ["read", "bash", "edit", "write"],
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		noTools: "all",
	});

	let finalText = "";
	let errorMessage: string | undefined;

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_end") {
			const message = event.message as {
				role?: string;
				content?: unknown;
				stopReason?: string;
				errorMessage?: string;
			};
			if (message.role !== "assistant") return;
			if (message.errorMessage) errorMessage = message.errorMessage;
			const text = extractAssistantText(message.content);
			if (text) finalText = text;
		}
	});

	const abortListener = () => session.agent.abort();
	ctx.signal?.addEventListener("abort", abortListener, { once: true });

	try {
		await session.prompt(userPrompt);
		await session.agent.waitForIdle();
	} catch (err: any) {
		if (!errorMessage) {
			errorMessage = err instanceof Error ? err.message : String(err);
		}
	} finally {
		ctx.signal?.removeEventListener("abort", abortListener);
		unsubscribe();
		session.dispose();
	}

	return {
		lens,
		text: finalText.trim(),
		modelName: model.name,
		durationMs: Date.now() - start,
		...(errorMessage ? { errorMessage } : {}),
	};
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => !!c && typeof c === "object" && c.type === "text")
		.map((c: any) => c.text ?? "")
		.join("");
}
