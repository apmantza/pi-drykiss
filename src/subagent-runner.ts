/**
 * Subagent runner — spawns each review lens as an in-process Pi agent session
 * via createAgentSession. Each subagent is a visible child session that the
 * user can see in Pi's UI.
 *
 * Pattern adapted from: https://github.com/vigolium/piolium
 */

import type { Model, Api, Usage } from "@earendil-works/pi-ai";
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
import type { AnyLens } from "./types.js";
import { extractAssistantText } from "./content-utils.js";
import { LENS_DISPLAY_NAMES, LOG_PREFIX } from "./constants.js";

/** Maximum time (ms) a single lens execution may run before being force-aborted. */
const LENS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Module-scoped caches for read-only session infrastructure
//
// DefaultResourceLoader and SettingsManager are both read-only for no-tool
// subagents. Creating them fresh on every lens session adds 0.1–0.5 s each
// (file I/O + JSON parsing). Caching them per (cwd, agentDir) or per
// (cwd, agentDir, systemPrompt) eliminates that overhead for the 2nd-through-
// Nth sessions spawned in a single review run (and across subsequent runs for
// the same workspace).
//
// SessionManager.inMemory(cwd) intentionally stays per-session — it holds
// per-session message history and must not be shared.
// ---------------------------------------------------------------------------

/**
 * Cache for SettingsManager instances keyed by `${cwd}::${agentDir}`.
 * SettingsManager reads settings from disk once; the result is immutable for
 * the lifetime of the process and safe to reuse across sessions.
 */
const settingsManagerCache = new Map<string, SettingsManager>();

/**
 * Cache for DefaultResourceLoader instances keyed by
 * `${cwd}::${agentDir}::${systemPrompt}`.
 *
 * Each lens has a distinct static system prompt, so the cache key includes
 * it. After the first review the loader is already loaded and cached; all
 * subsequent sessions for the same lens+workspace reuse the instance,
 * skipping the reload() I/O entirely.
 *
 * The loader is created with all resource-discovery flags disabled
 * (noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles), so
 * the only per-instance state is the systemPrompt string — making the cached
 * instance fully reusable.
 */
const resourceLoaderCache = new Map<string, DefaultResourceLoader>();

/**
 * Return a cached SettingsManager for the given (cwd, agentDir) pair,
 * creating one on first use.
 */
function getOrCreateSettingsManager(
	cwd: string,
	agentDir: string,
): SettingsManager {
	const key = `${cwd}::${agentDir}`;
	let sm = settingsManagerCache.get(key);
	if (!sm) {
		sm = SettingsManager.create(cwd, agentDir);
		settingsManagerCache.set(key, sm);
	}
	return sm;
}

/**
 * Return a cached DefaultResourceLoader for the given (cwd, agentDir,
 * systemPrompt) triple. On first use the loader is created and reload() is
 * awaited so the instance is fully initialised before being stored.
 */
async function getOrCreateResourceLoader(
	cwd: string,
	agentDir: string,
	systemPrompt: string,
): Promise<DefaultResourceLoader> {
	const key = `${cwd}::${agentDir}::${systemPrompt}`;
	let loader = resourceLoaderCache.get(key);
	if (!loader) {
		loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			systemPrompt,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		resourceLoaderCache.set(key, loader);
	}
	return loader;
}

export interface SubagentResult {
	lens: string;
	text: string;
	modelName: string;
	/** Provider id (e.g. "anthropic", "openai") for the model that ran. */
	provider?: string;
	durationMs: number;
	usage?: Usage;
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
	lenses: AnyLens[],
): Promise<Map<AnyLens, Model<Api>>> {
	const resolved = new Map<AnyLens, Model<Api>>();
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
	correlationId?: string,
): Promise<SubagentResult> {
	const start = Date.now();
	const displayName = LENS_DISPLAY_NAMES[lens] ?? lens;
	const agentDir = getAgentDir();

	let finalText = "";
	let errorMessage: string | undefined;
	let usage: Usage | undefined;
	let currentText = "";
	let session: AgentSession | undefined;

	try {
		// Reuse cached ResourceLoader and SettingsManager — both are read-only
		// for no-tool subagent sessions and safe to share across sessions for
		// the same (cwd, agentDir) workspace. SessionManager must remain
		// per-session because it holds session-scoped message history.
		const [resourceLoader, settingsManager] = await Promise.all([
			getOrCreateResourceLoader(cwd, agentDir, systemPrompt),
			Promise.resolve(getOrCreateSettingsManager(cwd, agentDir)),
		]);

		// Create session with SettingsManager for full Pi integration.
		// Since 0.80.8, createAgentSession builds its own ModelRuntime from
		// agentDir (auth.json + models.json); the host's modelRegistry is no
		// longer passable as a session option.
		const { session: created } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			resourceLoader,
			noTools: "all",
		});
		session = created;

		// Since 0.80.8, createAgentSession builds its own ModelRuntime from
		// agentDir (built-ins + models.json) and no longer inherits the host's
		// in-memory extension provider overlays. Copy those overlays across so
		// the subagent can resolve auth for models backed by extension-defined
		// providers (e.g. custom/self-hosted endpoints registered at startup).
		for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
			const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
			if (config) created.modelRuntime.registerProvider(providerId, config);
		}

		// Name the session so it appears in Pi's session list (like pi-subagents).
		// Include the correlationId when provided so validator sessions can be
		// traced back to their parent review job in Pi's UI.
		session.setSessionName(
			correlationId
				? `DRYKISS: ${displayName} [${correlationId}]`
				: `DRYKISS: ${displayName}`,
		);

		// Bind extensions so session_start fires and the session is fully initialized
		// This is critical for the session to be visible in Pi's UI
		await session.bindExtensions({
			onError: (err) => {
				console.error(
					"%s Extension error in %s:",
					LOG_PREFIX,
					displayName,
					err,
				);
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
					usage?: Usage;
				};
				if (message.role !== "assistant") return;
				if (message.errorMessage) errorMessage = message.errorMessage;
				if (message.usage) usage = message.usage;
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

		// Safety-net timeout handle — cleared in the finally block.
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		try {
			// Run the one-shot review directly through the core agent. AgentSession.prompt()
			// also runs session-level post-turn continuation hooks; for isolated
			// no-tool reviewer sessions those hooks can create a secondary continuation
			// error after the model has already produced a valid review.
			//
			// Wrap the two awaits in a Promise.race so that:
			//   • an abort signal cancels the wait immediately, and
			//   • a hard timeout prevents the session from hanging forever.
			const abortPromise = new Promise<never>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(new DOMException("Lens execution aborted", "AbortError"));
					return;
				}
				if (signal) {
					const onAbortRace = () =>
						reject(new DOMException("Lens execution aborted", "AbortError"));
					signal.addEventListener("abort", onAbortRace, { once: true });
					// Store a cleanup that removes this inner listener too.
					const outerDetach = detachAbort;
					detachAbort = () => {
						signal.removeEventListener("abort", onAbortRace);
						outerDetach?.();
					};
				}
			});

			const timeoutPromise = new Promise<never>((_resolve, reject) => {
				timeoutHandle = setTimeout(() => {
					session?.abort();
					reject(
						new Error(
							`Lens "${displayName}" timed out after ${LENS_TIMEOUT_MS / 1000}s`,
						),
					);
				}, LENS_TIMEOUT_MS);
			});

			const workPromise = (async () => {
				await session!.agent.prompt({
					role: "user",
					content: [{ type: "text", text: userPrompt }],
					timestamp: Date.now(),
				});
				await session!.agent.waitForIdle();
			})();

			await Promise.race([workPromise, abortPromise, timeoutPromise]);
		} finally {
			// Always clean up listeners and the timeout, even if prompt() throws.
			clearTimeout(timeoutHandle);
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
		provider: model.provider,
		durationMs: Date.now() - start,
		session,
		...(usage ? { usage } : {}),
		...(errorMessage ? { errorMessage } : {}),
	};
}

function isPostRunContinuationError(message: string | undefined): boolean {
	return (
		message?.includes("Cannot continue from message role: assistant") ?? false
	);
}
