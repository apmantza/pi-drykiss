export function extractBalancedJson(
	raw: string,
	open: string,
	close: string,
): string | null {
	let start = -1;
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === open) {
			start = i;
			break;
		}
	}
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escaped = true;
			continue;
		}
		if (ch === '"' && !escaped) {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (depth === 0) {
				return raw.slice(start, i + 1);
			}
		}
	}
	return null;
}

/**
 * Extract the first balanced top-level JSON array from arbitrary model
 * output, tolerating surrounding prose or ```json fences. Pure.
 */
export function extractBalancedJsonArray(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const haystack = fenced ? fenced[1] : text;
	return extractBalancedJson(haystack, "[", "]");
}
