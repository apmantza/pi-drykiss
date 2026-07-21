import { extractBalancedJson } from "./json-extract.js";
import { lenientJsonParse, sanitizeJsonString } from "./json-utils.js";
import { parseFindingsArray, type Finding, type AnyLens } from "./types.js";

export interface ParseFindingsResult {
	readonly findings: Finding[];
	readonly parseError?: string;
}

/**
 * Wrapper keys that lenses commonly use to wrap their findings array.
 * Ordered by expected frequency — `findings` is the canonical contract
 * (see prompt-builder prompt text in `json-output.md`), but LLM output
 * sometimes drifts to semantically equivalent keys. When the LLM wraps
 * the array under one of these, we accept it and unwrap transparently.
 */
const FINDINGS_WRAPPER_KEYS: readonly string[] = [
	"findings", // canonical contract
	"results",
	"issues",
	"violations",
	"defects",
	"problems",
	"items",
	"data",
	"output",
	"review",
	"lens_findings",
];

/**
 * Find the first array-typed property on an object whose key matches a
 * known findings-wrapper name. Returns the array, or undefined.
 *
 * Used to recover from LLM drift: when a lens returns
 * `{ "results": [...] }` instead of the canonical
 * `{ "findings": [...] }`, we still surface the findings.
 */
function findWrapperArray(obj: Record<string, unknown>): unknown[] | undefined {
	for (const key of FINDINGS_WRAPPER_KEYS) {
		const v = obj[key];
		if (Array.isArray(v)) return v;
	}
	return undefined;
}

/**
 * Required fields that identify a plain object as a single finding.
 * Used as a last-rescue fallback when the LLM emits one finding object
 * instead of the required JSON array. We intentionally only require the
 * minimal identity fields (file + severity + some textual content). The
 * validator downstream will reject malformed findings with empty required
 * fields, but treating the object as a finding here prevents a parse error
 * from swallowing the lens output entirely.
 */
const FINDING_REQUIRED_FIELDS: readonly string[] = [
	"file",
	"severity",
	"summary",
];
const FINDING_CONTENT_FIELDS: readonly string[] = [
	"summary",
	"category",
	"detail",
	"suggestion",
];

function looksLikeFinding(obj: Record<string, unknown>): boolean {
	const hasIdentity = FINDING_REQUIRED_FIELDS.every(
		(field) =>
			Object.hasOwn(obj, field) &&
			typeof obj[field] === "string" &&
			String(obj[field]).trim().length > 0,
	);
	if (!hasIdentity) return false;
	const hasContent = FINDING_CONTENT_FIELDS.some(
		(field) =>
			Object.hasOwn(obj, field) &&
			typeof obj[field] === "string" &&
			String(obj[field]).trim().length > 0,
	);
	if (!hasContent) return false;
	const severity = String(obj.severity);
	return ["critical", "high", "medium", "low", "nit"].includes(severity);
}

export function parseFindingsJson(
	raw: string,
	lens?: AnyLens,
): ParseFindingsResult {
	try {
		// Repair unescaped quotes / newlines inside string values FIRST, so the
		// balanced-extraction and parse steps see valid JSON. Calling
		// extractBalancedJson on the unsanitized raw loses track of strings at the
		// first unescaped quote and truncates the structure (e.g. docs lenses
		// emit `loadPromptBody("iron-law", "shared")` inside a JSON string).
		const sanitized = sanitizeJsonString(raw);

		// Some lenses wrap the whole array in an object; some emit a single
		// finding object. Extract the largest balanced JSON structure so we
		// can parse either shape instead of assuming an array.
		const arrExtract = extractBalancedJson(sanitized, "[", "]");
		const objExtract = extractBalancedJson(sanitized, "{", "}");
		let jsonText = sanitized;
		if (arrExtract) {
			// A balanced array is the canonical lens output shape. Prefer it
			// over an object so we recover findings nested inside wrapper
			// objects (e.g. { "lens_output": { "findings": [...] } }).
			jsonText = arrExtract;
		} else if (objExtract) {
			// No array found: fall back to the object, which may be a single
			// finding or a wrapper object with a non-enumerated key.
			jsonText = objExtract;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonText);
		} catch {
			// jsonText is already sanitized; fall back to the tolerant parser
			// for trailing-comma / single-quote / unterminated cases.
			parsed = lenientJsonParse(jsonText, lens);
		}

		// Normalize the parsed value to a findings array:
		//   1. Array -> use as-is (canonical contract).
		//   2. Object -> look for a known wrapper key (findings, results,
		//      issues, violations, defects, problems, items, data, output,
		//      review, lens_findings) holding an array.
		//   3. Object -> if it looks like a single finding, wrap it in an array.
		//   4. Object -> fall back to scanning for the first array-typed
		//      property (last-ditch recovery from LLM drift to a new
		//      wrapper key we haven't enumerated yet).
		//   5. Anything else -> return a parse error.
		let findingsSource: unknown = parsed;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			const obj = parsed as Record<string, unknown>;
			const wrapper = findWrapperArray(obj);
			if (wrapper) {
				findingsSource = wrapper;
			} else if (looksLikeFinding(obj)) {
				findingsSource = [obj];
			} else {
				// Last-ditch: pick the first array-typed property.
				const firstArray = Object.values(obj).find((v) => Array.isArray(v));
				if (firstArray) findingsSource = firstArray;
			}
		}

		if (!Array.isArray(findingsSource)) {
			const objType =
				typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
					? `object (keys: ${Object.keys(parsed as Record<string, unknown>)
							.slice(0, 5)
							.join(", ")})`
					: typeof parsed;
			return {
				findings: [],
				parseError: `Expected array, got ${objType}`,
			};
		}

		return { findings: parseFindingsArray(findingsSource, lens) };
	} catch {
		const lensContext = lens ? ` for ${lens} lens` : "";
		const msg = `Failed to parse JSON${lensContext} (original response length: ${raw.length} chars). The LLM output may contain unescaped characters.`;
		return { findings: [], parseError: msg };
	}
}
