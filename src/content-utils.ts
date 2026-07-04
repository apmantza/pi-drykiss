/**
 * Shared utilities for extracting text content from AI message blocks.
 */

/**
 * Strip ANSI escape sequences from strings to prevent injection.
 * Matches CSI sequences (SGR, cursor movement, etc.) and OSC sequences
 * (hyperlinks, window title).
 */
export function stripAnsi(s: string): string {
	// OSC: ESC ] ... ST (BEL \x07 or ESC \)
	// CSI: ESC [ params letters
	return s.replace(
		/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
		"",
	);
}

/**
 * Extract text content from an AI assistant message content array.
 * Handles both string content and array of content blocks.
 */
export function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) => {
			if (!block || typeof block !== "object") return [];
			const maybeText = block as { type?: unknown; text?: unknown };
			return maybeText.type === "text" && typeof maybeText.text === "string"
				? [maybeText.text]
				: [];
		})
		.join("");
}
