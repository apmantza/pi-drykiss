/**
 * Subagent runner — spawns each review lens as an in-process Pi agent session
 * via createAgentSession. Each subagent is a visible child session that the
 * user can see in Pi's UI.
 *
 * Pattern adapted from: https://github.com/vigolium/piolium
 */

import type { Model, Api } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	getAgentDir,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelSmart } from "./llm.js";
import type { ReviewLens } from "./types.js";

export interface SubagentResult {
	lens: string;
	text: string;
	modelName: string;
	durationMs: number;
	errorMessage?: string;
	/** The live session object — caller must dispose when no longer needed. */
	session?: AgentSession;
}

/**
 * Resolve a model for a lens. Thin wrapper around resolveModelSmart
 * that throws instead of returning undefined.
 */
export async function resolveModel(
	ctx: ExtensionContext,
	cwd: string,
	lens: string,
): Promise<Model<Api>> {
	const model = await resolveModelSmart(ctx, cwd, undefined, lens);
	if (!model) {
		throw new Error("No models available. Configure an API key with /login.");
	}
	return model;
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
	_ctx: ExtensionContext,
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

	// Intentionally NOT wiring to ctx.signal — these are background reviews
	// that should survive the user cancelling the parent agent turn.
	try {
		await session.prompt(userPrompt);
		await session.agent.waitForIdle();
	} catch (err: any) {
		if (!errorMessage) {
			errorMessage = err instanceof Error ? err.message : String(err);
		}
	} finally {
		unsubscribe();
		// NOTE: session is NOT disposed here — caller (ReviewManager) keeps it
		// alive so the conversation can be viewed via /drykiss-jobs.
	}

	return {
		lens,
		text: finalText.trim(),
		modelName: model.name,
		durationMs: Date.now() - start,
		session,
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
