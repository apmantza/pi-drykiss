/**
 * Lenient JSON parser that handles common LLM output issues.
 * Tries strict parse first, then applies fixes for:
 * - Unescaped newlines in string values
 * - Trailing commas before } or ]
 * - Unescaped control characters
 * - Unterminated strings (best-effort)
 * - Markdown code fences around JSON
 * - Unescaped double quotes inside string values (common in docs/code lenses)
 */

import { extractBalancedJson } from "./json-extract.js";

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonMarkdownFences(raw: string): string {
	return raw.replace(/^```(?:json)?\s*\n?/gm, "").replace(/```\s*$/gm, "");
}

function fixTrailingCommas(raw: string): string {
	return raw.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Repair unescaped double quotes that appear inside JSON string values.
 * LLMs reviewing docs or code often emit inline quotes without escaping
 * them, which terminates the string early. We use a look-ahead heuristic:
 * a quote inside a string is escaped unless it is immediately followed by a
 * JSON structural token (optionally after whitespace) — in which case we
 * treat it as the string's closing delimiter.
 *
 * This is a best-effort repair; inherently ambiguous cases (multiple inline
 * quotes where one is followed by a structural char) are additionally
 * prevented at the prompt level by instructing lenses to escape double
 * quotes or use single quotes inside JSON strings.
 */
function repairUnescapedQuotes(raw: string): string {
	const result: string[] = [];
	let i = 0;
	let inString = false;
	let escaped = false;

	while (i < raw.length) {
		const ch = raw[i];

		if (escaped) {
			result.push(ch);
			escaped = false;
			i++;
			continue;
		}

		if (ch === "\\") {
			result.push(ch);
			escaped = true;
			i++;
			continue;
		}

		if (ch === '"') {
			if (!inString) {
				inString = true;
				result.push(ch);
			} else {
				// Look ahead to decide if this is a closing quote or an
				// unescaped quote inside the string value.
				let j = i + 1;
				while (j < raw.length && /\s/.test(raw[j])) j++;
				const next = raw[j];
				if (
					next === "," ||
					next === ":" ||
					next === "}" ||
					next === "]" ||
					next === undefined
				) {
					inString = false;
					result.push(ch);
				} else {
					result.push('\\"');
				}
			}
			i++;
			continue;
		}

		result.push(ch);
		i++;
	}

	return result.join("");
}

/**
 * Shared first-pass repair used by both lenient parsing and sanitization:
 * strip markdown fences, repair unescaped inline quotes.
 */
function stripAndRepairQuotes(raw: string): string {
	let s = raw;
	s = stripJsonMarkdownFences(s);
	s = repairUnescapedQuotes(s);
	return s;
}

type ControlCharReplacer = (ch: "\n" | "\r" | "\t") => string;

/**
 * Walk the input and replace/control-escape literal newlines, carriage
 * returns, and tabs that appear inside JSON string values. The scan is
 * state-machine driven so it respects escaped quotes and backslashes.
 */
function processStringControlChars(
	raw: string,
	replacer: ControlCharReplacer,
): string {
	const result: string[] = [];
	let i = 0;

	while (i < raw.length) {
		if (raw[i] !== '"') {
			result.push(raw[i]);
			i++;
			continue;
		}

		// Start of a string
		result.push('"');
		i++;
		while (i < raw.length) {
			const ch = raw[i];
			if (ch === "\\") {
				result.push(ch);
				i++;
				if (i < raw.length) {
					result.push(raw[i]);
					i++;
				}
				continue;
			}
			if (ch === '"') {
				result.push('"');
				i++;
				break;
			}
			if (ch === "\n" || ch === "\r" || ch === "\t") {
				result.push(replacer(ch));
				i++;
				continue;
			}
			result.push(ch);
			i++;
		}
	}

	return result.join("");
}

export function lenientJsonParse<T = unknown>(raw: string, label?: string): T {
	const originalLength = raw.length;
	const prefix = label ? `[${label}] ` : "";

	// Try strict parse first (fast path)
	try {
		return JSON.parse(raw) as T;
	} catch {
		// Fall through to lenient parsing
	}

	let fixed = stripAndRepairQuotes(raw);

	// Extract JSON object or array if wrapped in text
	const objMatch = extractBalancedJson(fixed, "{", "}");
	if (objMatch) {
		fixed = objMatch;
	} else {
		const arrMatch = extractBalancedJson(fixed, "[", "]");
		if (arrMatch) fixed = arrMatch;
	}

	// Fix trailing commas (common LLM mistake)
	fixed = fixTrailingCommas(fixed);

	// Escape literal newlines/tabs inside string values
	fixed = processStringControlChars(fixed, (ch) => {
		if (ch === "\n") return "\\n";
		if (ch === "\r") return "\\r";
		return "\\t";
	});

	// Fix single quotes used as string delimiters (rare but happens)
	// Only do this if there are no double quotes (pure single-quote JSON)
	// SECURITY: Only convert when no double quotes exist to avoid corrupting
	// strings that legitimately contain apostrophes in double-quoted JSON.
	if (!fixed.includes('"') && fixed.includes("'")) {
		fixed = fixed.replaceAll(/'/g, '"');
	}

	// Try to fix unterminated strings by finding last complete object/array
	// Find the last } or ] and truncate there
	const lastObjBrace = fixed.lastIndexOf("}");
	const lastArrBracket = fixed.lastIndexOf("]");
	const lastComplete = Math.max(lastObjBrace, lastArrBracket);
	let truncationDetail = "";
	if (lastComplete > 0 && lastComplete < fixed.length - 1) {
		const truncatedChars = fixed.length - lastComplete - 1;
		truncationDetail = ` (truncated ${truncatedChars} trailing chars to reach last closing delimiter)`;
		fixed = fixed.substring(0, lastComplete + 1);
	}

	// Final attempt
	try {
		return JSON.parse(fixed) as T;
	} catch (err) {
		throw new Error(
			`${prefix}Failed to parse repaired JSON (original response length: ${originalLength} chars${truncationDetail}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
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
	let s = stripAndRepairQuotes(raw);

	// Replace literal newlines/tabs inside strings with spaces
	s = processStringControlChars(s, () => " ");

	// Remove trailing commas before } or ]
	s = fixTrailingCommas(s);

	return s;
}
