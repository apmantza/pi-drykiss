/**
 * Shared utilities for extracting text content from AI message blocks.
 */

/**
 * Strip ANSI escape sequences from strings to prevent injection.
 * Matches CSI sequences (SGR, cursor movement, etc.) and OSC sequences.
 */
export function stripAnsi(s: string): string {
	return s.replace(
		/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
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
		.filter(
			(c: any): c is { type: "text"; text: string } =>
				!!c && typeof c === "object" && c.type === "text",
		)
		.map((c: { type: string; text: string }) => c.text ?? "")
		.join("");
}
