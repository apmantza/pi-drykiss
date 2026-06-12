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
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelSmart } from "./llm.js";
import type { ReviewLens } from "./types.js";
import { extractAssistantText } from "./content-utils.js";
import { LENS_DISPLAY_NAMES, LOG_PREFIX } from "./constants.js";

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
	lens: string,
): Promise<Model<Api>> {
	const model = await resolveModelSmart(ctx, undefined, lens);
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
	lenses: ReviewLens[],
): Promise<Map<ReviewLens, Model<Api>>> {
	const resolved = new Map<ReviewLens, Model<Api>>();
	for (const lens of lenses) {
		resolved.set(lens, await resolveModel(ctx, lens));
	}
	return resolved;
}

/**
 * Spawn a single lens review as a Pi subagent.
 * Each session is named so it appears in Pi's session list.
 * Pattern adapted from: https://github.com/tintinweb/pi-subagents
 */
export async function runLensSubagent(
	ctx: ExtensionContext,
	cwd: string,
	model: Model<Api>,
	systemPrompt: string,
	userPrompt: string,
	lens: string,
	signal?: AbortSignal,
	onStreamUpdate?: () => void,
): Promise<SubagentResult> {
	const start = Date.now();
	const displayName = LENS_DISPLAY_NAMES[lens] ?? lens;
	const agentDir = getAgentDir();

	let finalText = "";
	let errorMessage: string | undefined;
	let currentText = "";
	let session: AgentSession | undefined;

	try {
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			systemPrompt,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		// Create session with SettingsManager and modelRegistry for full Pi integration
		// (matches pi-subagents pattern for visible sessions)
		const { session: created } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.create(cwd, agentDir),
			modelRegistry: ctx.modelRegistry,
			resourceLoader,
			noTools: "all",
		});
		session = created;

		// Name the session so it appears in Pi's session list (like pi-subagents)
		session.setSessionName(`DRYKISS: ${displayName}`);

		// Bind extensions so session_start fires and the session is fully initialized
		// This is critical for the session to be visible in Pi's UI
		await session.bindExtensions({
			onError: (err) => {
				console.error(`${LOG_PREFIX} Extension error in ${displayName}:`, err);
			},
		});

		// Subscribe to session events for streaming progress (like pi-subagents)
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_start") {
				currentText = "";
			}
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent?.type === "text_delta"
			) {
				currentText += event.assistantMessageEvent.delta;
				onStreamUpdate?.();
			}
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

		// Wire abort signal to cancel the session
		let detachAbort: (() => void) | undefined;
		if (signal) {
			const onAbort = () => session?.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			detachAbort = () => signal?.removeEventListener("abort", onAbort);
		}

		try {
			// Run the one-shot review directly through the core agent. AgentSession.prompt()
			// also runs session-level post-turn continuation hooks; for isolated
			// no-tool reviewer sessions those hooks can create a secondary continuation
			// error after the model has already produced a valid review.
			await session.agent.prompt({
				role: "user",
				content: [{ type: "text", text: userPrompt }],
				timestamp: Date.now(),
			});
			await session.agent.waitForIdle();
		} finally {
			// Always clean up listeners, even if prompt() throws
			unsubscribe();
			detachAbort?.();
			// NOTE: session is NOT disposed here — caller (ReviewManager) keeps
			// it alive so the conversation can be viewed via /drykiss-jobs.
		}
	} catch (err: any) {
		// Surface any error from setup, session creation, binding, or prompt
		// to the caller as an errorMessage on the result, rather than letting
		// the promise reject. This keeps the caller's retry/error pipeline
		// single-pathed and avoids unhandled rejection warnings.
		// Retry logic is handled by ReviewManager so the user is only prompted
		// once (not here and again at the job level).
		if (!errorMessage) {
			errorMessage = err instanceof Error ? err.message : String(err);
		}
		// If a session was created before the error, dispose it to avoid
		// resource leaks (partially initialized sessions with open file
		// handles or subscriptions). The caller should not receive a broken
		// session object.
		if (session) {
			try {
				session.dispose();
			} catch {
				/* dispose is best-effort */
			}
			session = undefined;
		}
	}

	const text = finalText.trim();
	if (text && isPostRunContinuationError(errorMessage)) {
		errorMessage = undefined;
	}

	return {
		lens,
		text,
		modelName: model.name,
		durationMs: Date.now() - start,
		session,
		...(errorMessage ? { errorMessage } : {}),
	};
}

function isPostRunContinuationError(message: string | undefined): boolean {
	return (
		message?.includes("Cannot continue from message role: assistant") ?? false
	);
}
