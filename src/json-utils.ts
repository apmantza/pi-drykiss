/**
 * Lenient JSON parser that handles common LLM output issues.
 * Tries strict parse first, then applies fixes for:
 * - Unescaped newlines in string values
 * - Trailing commas before } or ]
 * - Unescaped control characters
 * - Unterminated strings (best-effort)
 * - Markdown code fences around JSON
 */
function stripJsonMarkdownFences(raw: string): string {
	return raw.replace(/^```(?:json)?\s*\n?/gm, "").replace(/```\s*$/gm, "");
}

function fixTrailingCommas(raw: string): string {
	return raw.replace(/,\s*([}\]])/g, "$1");
}

export function lenientJsonParse<T = unknown>(raw: string): T {
	// Try strict parse first (fast path)
	try {
		return JSON.parse(raw) as T;
	} catch {
		// Fall through to lenient parsing
	}

	let fixed = raw;

	// 1. Remove markdown code fences if present
	fixed = stripJsonMarkdownFences(fixed);

	// 2. Extract JSON object or array if wrapped in text
	// Use brace/bracket depth tracking to correctly handle nested structures
	function extractBalanced(
		input: string,
		open: string,
		close: string,
	): string | null {
		let start = -1;
		for (let i = 0; i < input.length; i++) {
			if (input[i] === open) {
				start = i;
				break;
			}
		}
		if (start === -1) return null;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < input.length; i++) {
			const ch = input[i];
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
			if (ch === open) depth++;
			if (ch === close) {
				depth--;
				if (depth === 0) return input.substring(start, i + 1);
			}
		}
		return null;
	}
	const objMatch = extractBalanced(fixed, "{", "}");
	const arrMatch = objMatch ? null : extractBalanced(fixed, "[", "]");
	if (objMatch) {
		fixed = objMatch;
	} else if (arrMatch) {
		fixed = arrMatch;
	}

	// 3. Fix trailing commas (common LLM mistake)
	fixed = fixTrailingCommas(fixed);

	// 4. Fix unescaped newlines inside string values
	// This regex matches content between quotes and escapes literal newlines
	fixed = fixed.replace(/"([^"]*)"/g, (match, content) => {
		// Only process if there are unescaped newlines
		if (!content.includes("\n")) return match;
		// Escape the newlines
		const escaped = content.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
		return `"${escaped}"`;
	});

	// 5. Fix unescaped tabs inside string values
	fixed = fixed.replace(/"([^"]*)"/g, (match, content) => {
		if (!content.includes("\t")) return match;
		const escaped = content.replace(/\t/g, "\\t");
		return `"${escaped}"`;
	});

	// 6. Fix single quotes used as string delimiters (rare but happens)
	// Only do this if there are no double quotes (pure single-quote JSON)
	// SECURITY: Only convert when no double quotes exist to avoid corrupting
	// strings that legitimately contain apostrophes in double-quoted JSON.
	if (!fixed.includes('"') && fixed.includes("'")) {
		fixed = fixed.replace(/'/g, '"');
	}

	// 3. Try to fix unterminated strings by finding last complete object/array
	// Find the last } or ] and truncate there
	const lastObjBrace = fixed.lastIndexOf("}");
	const lastArrBracket = fixed.lastIndexOf("]");
	const lastComplete = Math.max(lastObjBrace, lastArrBracket);
	if (lastComplete > 0 && lastComplete < fixed.length - 1) {
		fixed = fixed.substring(0, lastComplete + 1);
	}

	// Final attempt
	return JSON.parse(fixed) as T;
}

/**
 * Attempt to repair common LLM JSON issues:
 * - Unescaped control characters (newlines, tabs) inside strings
 * - Trailing commas before } or ]
 * - Markdown code fences around JSON
 *
 * Returns the sanitized string ready for JSON.parse().
 */
export function sanitizeJsonString(raw: string): string {
	let s = raw;

	// Remove markdown code fences if present
	s = stripJsonMarkdownFences(s);

	// Replace literal newlines/tabs inside strings with escaped versions
	// Use depth-aware scanner to correctly handle escaped quotes and nested braces
	function sanitizeStrings(s: string): string {
		const result: string[] = [];
		let i = 0;
		while (i < s.length) {
			if (s[i] !== '"') {
				result.push(s[i]);
				i++;
				continue;
			}
			// Start of a string
			result.push('"');
			i++;
			while (i < s.length) {
				const ch = s[i];
				if (ch === "\\") {
					result.push(ch);
					i++;
					if (i < s.length) {
						result.push(s[i]);
						i++;
					}
					continue;
				}
				if (ch === '"') {
					result.push('"');
					i++;
					break;
				}
				if (ch === "\n") {
					result.push(" ");
					i++;
					continue;
				}
				if (ch === "\r") {
					result.push(" ");
					i++;
					continue;
				}
				if (ch === "\t") {
					result.push(" ");
					i++;
					continue;
				}
				result.push(ch);
				i++;
			}
		}
		return result.join("");
	}
	s = sanitizeStrings(s);

	// Remove trailing commas before } or ]
	s = fixTrailingCommas(s);

	return s;
}
