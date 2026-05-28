/**
 * Shared utilities for extracting text content from AI message blocks.
 */

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
