import { detectLanguage } from "./git-diff.js";
import type { EditedFile, TurnEdits } from "./types.js";

const FILE_PATH_RE = /(?:File|file|path)[:\s]+(\S+)/;

const TRACKED_TOOLS = new Set(["write", "edit"]);

/**
 * Sanitize a file path string for safe embedding in system prompts.
 * Strips newlines, control characters, and non-printable chars.
 */
function sanitizePath(s: string): string {
	return s.replace(/[\n\r\x00-\x1f\x7f]/g, "").trim();
}

function extractFilePath(...values: unknown[]): string | null {
	for (const value of values) {
		const path = extractFilePathFromValue(value);
		if (path) return path;
	}
	return null;
}

function extractFilePathFromValue(result: unknown): string | null {
	if (!result) return null;

	if (typeof result === "object") {
		const obj = result as Record<string, unknown>;
		if (typeof obj["file_path"] === "string") return sanitizePath(obj["file_path"]);
		if (typeof obj["path"] === "string") return sanitizePath(obj["path"]);
		if (typeof obj["filePath"] === "string") return sanitizePath(obj["filePath"]);
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
