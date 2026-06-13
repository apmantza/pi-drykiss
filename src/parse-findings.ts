import { lenientJsonParse, sanitizeJsonString } from "./json-utils.js";
import { parseFindingsArray, type Finding, type ReviewLens } from "./types.js";

export interface ParseFindingsResult {
	readonly findings: Finding[];
	readonly parseError?: string;
}

function extractBalancedJson(
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

export function parseFindingsJson(
	raw: string,
	lens?: ReviewLens,
): ParseFindingsResult {
	try {
		const jsonText = extractBalancedJson(raw, "[", "]") ?? raw;
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonText);
		} catch {
			try {
				parsed = JSON.parse(sanitizeJsonString(jsonText));
			} catch {
				parsed = lenientJsonParse(jsonText);
			}
		}
		const findingsSource =
			typeof parsed === "object" &&
			parsed !== null &&
			"findings" in parsed &&
			Array.isArray((parsed as { findings?: unknown }).findings)
				? (parsed as { findings: unknown[] }).findings
				: parsed;

		if (!Array.isArray(findingsSource)) {
			return {
				findings: [],
				parseError: `Expected array, got ${typeof parsed}`,
			};
		}

		return { findings: parseFindingsArray(findingsSource, lens) };
	} catch {
		const msg = lens
			? `Failed to parse JSON for ${lens} lens. The LLM output may contain unescaped characters.`
			: "Failed to parse JSON. The LLM output may contain unescaped characters.";
		return { findings: [], parseError: msg };
	}
}
