import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { redactSecrets } from "./secret-redaction.js";

/** Append-only diagnostic log for autoreview lifecycle events. */
export const AUTOREVIEW_LOG_PATH = join(
	homedir(),
	".pi",
	"drykiss",
	"autoreview.log",
);

let pendingWrite: Promise<void> = Promise.resolve();

function safeDetails(
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
		) {
			result[key] =
				typeof value === "string"
					? redactSecrets(value).text.slice(0, 500)
					: value;
		} else if (Array.isArray(value)) {
			result[key] = value.slice(0, 20);
		}
	}
	return result;
}

/** Return numeric token/cost fields suitable for lifecycle logs. */
export function tokenUsageDetails(
	usage: Usage | undefined,
): Record<string, number> | undefined {
	if (!usage) return undefined;
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		costTotal: usage.cost.total,
		...(usage.cacheWrite1h === undefined
			? {}
			: { cacheWrite1hTokens: usage.cacheWrite1h }),
		...(usage.reasoning === undefined
			? {}
			: { reasoningTokens: usage.reasoning }),
	};
}

/**
 * Write one structured lifecycle event. Logging is deliberately fail-safe:
 * a read-only home directory or disk error must never affect a review.
 */
export function logAutoreviewEvent(
	event: string,
	details?: Record<string, unknown>,
): void {
	const record = {
		timestamp: new Date().toISOString(),
		event,
		...(safeDetails(details) ?? {}),
	};
	const line = `${JSON.stringify(record)}\n`;
	pendingWrite = pendingWrite
		.then(async () => {
			try {
				await mkdir(join(homedir(), ".pi", "drykiss"), {
					recursive: true,
				});
				await appendFile(AUTOREVIEW_LOG_PATH, line, "utf8");
			} catch {
				// Diagnostics must never change review behavior.
			}
		})
		.catch(() => undefined);
}

export function logAutoreviewError(
	event: string,
	error: unknown,
	details?: Record<string, unknown>,
): void {
	logAutoreviewEvent(event, {
		...details,
		error: error instanceof Error ? error.message : String(error),
	});
}
