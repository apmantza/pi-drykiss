import { detectLanguage } from "./git-diff.js";
import type { EditedFile, TurnEdits } from "./types.js";

const FILE_PATH_RE = /(?:File|file|path)[:\s]+(\S+)/;

const TRACKED_TOOLS = new Set(["write", "edit"]);

/**
 * Sanitize a file path string for safe embedding in system prompts.
 * Rejects absolute paths, parent-directory traversal, control characters,
 * and any characters outside the safe set.
 */
function sanitizePath(s: string): string | null {
	// Reject control characters outright rather than silently stripping them,
	// so injected newlines cannot smuggle additional prompt instructions.
	if (/[\n\r\x00-\x1f\x7f]/.test(s)) return null;

	const cleaned = s.trim();
	if (cleaned.length === 0) return null;

	// Reject absolute paths and parent-directory traversal segments.
	if (
		cleaned.startsWith("/") ||
		cleaned.startsWith("\\") ||
		/^[a-zA-Z]:/.test(cleaned) ||
		/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(cleaned)
	) {
		return null;
	}

	// Only allow a safe subset of characters commonly found in repo paths.
	if (!/^[\w\s./\\\-+#@$%&()[\]{}]+$/.test(cleaned)) {
		return null;
	}

	return cleaned;
}

function extractFilePath(a: unknown, b: unknown): string | null {
	const fromA = extractFilePathFromValue(a);
	if (fromA) return fromA;
	return extractFilePathFromValue(b);
}

function extractFilePathFromValue(result: unknown): string | null {
	if (!result) return null;

	if (typeof result === "object") {
		const obj = result as Record<string, unknown>;
		if (typeof obj["file_path"] === "string")
			return sanitizePath(obj["file_path"]);
		if (typeof obj["path"] === "string") return sanitizePath(obj["path"]);
		if (typeof obj["filePath"] === "string")
			return sanitizePath(obj["filePath"]);
		if (obj["details"]) return extractFilePathFromValue(obj["details"]);
	}

	if (typeof result === "string") {
		const match = result.match(FILE_PATH_RE);
		const raw = match?.[1] ?? null;
		return raw ? sanitizePath(raw) : null;
	}

	return null;
}

export interface EditTracker {
	trackEdit(
		toolName: string,
		result: unknown,
		input?: unknown,
	): EditedFile | null;
	onTurnEnd(turnIndex: number): void;
	getLastTurnEdits(): TurnEdits | null;
	clearLastTurnEdits(): void;
}

export function createEditTracker(): EditTracker {
	const current = new Map<string, EditedFile>();
	let lastTurn: TurnEdits | null = null;

	return {
		trackEdit(
			toolName: string,
			result: unknown,
			input?: unknown,
		): EditedFile | null {
			if (!TRACKED_TOOLS.has(toolName.toLowerCase())) return null;

			const path = extractFilePath(input, result);
			if (!path) return null;

			const language = detectLanguage(path);
			const edited = { path, language };
			if (!current.has(path)) current.set(path, edited);
			return edited;
		},

		onTurnEnd(turnIndex: number): void {
			if (current.size === 0) {
				lastTurn = null;
			} else {
				lastTurn = { files: [...current.values()], turnIndex };
			}
			current.clear();
		},

		getLastTurnEdits(): TurnEdits | null {
			return lastTurn;
		},

		clearLastTurnEdits(): void {
			lastTurn = null;
		},
	};
}
