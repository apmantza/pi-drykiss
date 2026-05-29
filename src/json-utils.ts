/**
 * Lenient JSON parser that handles common LLM output issues.
 * Tries strict parse first, then applies fixes for:
 * - Unescaped newlines in string values
 * - Trailing commas before } or ]
 * - Unescaped control characters
 * - Unterminated strings (best-effort)
 * - Markdown code fences around JSON
 */
export function lenientJsonParse<T = unknown>(raw: string): T {
	// Try strict parse first (fast path)
	try {
		return JSON.parse(raw) as T;
	} catch {
		// Fall through to lenient parsing
	}

	let fixed = raw;

	// 1. Remove markdown code fences if present
	fixed = fixed.replace(/^```(?:json)?\s*\n?/gm, "").replace(/```\s*$/gm, "");

	// 2. Extract JSON object or array if wrapped in text
	const objMatch = fixed.match(/\{[\s\S]*\}/);
	const arrMatch = fixed.match(/\[[\s\S]*\]/);
	if (objMatch) {
		fixed = objMatch[0];
	} else if (arrMatch) {
		fixed = arrMatch[0];
	}

	// 3. Fix trailing commas (common LLM mistake)
	// Matches: ,} or ,] (with optional whitespace between)
	fixed = fixed.replace(/,\s*([}\]])/g, "$1");

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
	if (!fixed.includes('"') && fixed.includes("'")) {
		fixed = fixed.replace(/'/g, '"');
	}

	// 7. Try to fix unterminated strings by finding last complete object/array
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
	s = s.replace(/```(?:json)?\s*/gi, "");

	// Replace literal newlines/tabs inside strings with escaped versions
	// This regex is imperfect but handles most cases
	s = s.replace(/"([^"]*)"/g, (_match, content: string) => {
		// Only sanitize if the content contains problematic characters
		if (
			content.includes("\n") ||
			content.includes("\t") ||
			content.includes("\r")
		) {
			const sanitized = content
				.replace(/\r\n/g, " ")
				.replace(/\n/g, " ")
				.replace(/\t/g, " ")
				.replace(/"/g, '\\"');
			return `"${sanitized}"`;
		}
		return _match;
	});

	// Remove trailing commas before } or ]
	s = s.replace(/,\s*([}\]])/g, "$1");

	return s;
}
