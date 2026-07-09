/**
 * active-constraints.ts — Format a RiskTargeting config into a human-readable
 * "Active Constraints" block that gets injected into the lens and synthesis
 * system prompts via the `{{active_constraints}}` placeholder in
 * `src/prompts/_shared/active-constraints.md`.
 *
 * The output is plain English so the LLM can act on it directly. The
 * composer does a simple `{{key}}` substitution — no template engine.
 *
 * 🇨 Security: All user-supplied config values are wrapped in inline code
 * backticks to prevent prompt injection. Risk codes are validated against
 * the known RISK_CODES catalogue. Severity values are validated against
 * the known SeverityOverride union.
 */
import type { RiskTargeting, SeverityOverride } from "./config.js";
import { RISK_CODES } from "./prompts/risk-codes.js";
import { SEVERITY_VALUES } from "./constants.js";

/**
 * Return a multi-line string describing the active risk-targeting
 * configuration. Returns an empty string when no constraints are active
 * (the composer treats that as "don't include the active-constraints.md
 * fragment at all").
 *
 * All user-supplied strings are wrapped in backticks to prevent prompt
 * injection. Risk codes are validated against known codes.
 */
export function buildActiveConstraints(rt: RiskTargeting | undefined): string {
	if (!rt) return "";
	const lines: string[] = [];

	if (rt.disable && rt.disable.length > 0) {
		lines.push(
			`- DISABLED risk codes (do NOT report findings of these types): ${rt.disable.map(safeFormatCode).join(", ")}`,
		);
	}

	if (rt.focus && rt.focus.length > 0) {
		lines.push(
			`- FOCUSED risk codes (report ONLY findings of these types): ${rt.focus.map(safeFormatCode).join(", ")}`,
		);
	}

	if (rt.severity && rt.severity.length > 0) {
		lines.push("- Severity overrides (applied to matching risk codes):");
		for (const rule of rt.severity) {
			const codeStr = safeFormatCode(rule.riskCode);
			const severityStr = SEVERITY_VALUES.has(rule.to)
				? `\`${rule.to}\``
				: `\`${sanitizeInline(rule.to)}\``;
			lines.push(
				`  - ${codeStr}: report as ${severityStr} instead of the default`,
			);
		}
	}

	if (rt.ignore && rt.ignore.length > 0) {
		const formatted = rt.ignore
			.map((g) => `\`${sanitizeInline(g)}\``)
			.join(", ");
		lines.push(
			`- IGNORED file globs (do NOT report findings in files matching): ${formatted}`,
		);
	}

	return lines.join("\n");
}

/**
 * Format a risk code as a backtick-wrapped literal with optional
 * human-readable name. Unknown codes are still wrapped in backticks
 * to prevent injection.
 */
function safeFormatCode(code: string): string {
	// Validate against the known catalogue before indexing, so an
	// unrecognised code can't trip an unchecked cast.
	if (Object.hasOwn(RISK_CODES, code)) {
		const def = RISK_CODES[code as keyof typeof RISK_CODES];
		return `\`${code}\` (${sanitizeInline(def.name)})`;
	}
	return `\`${sanitizeInline(code)}\``;
}

/**
 * Strip characters that could break out of an inline code span or
 * inject control sequences into the rendered prompt.
 * Backticks are stripped (cannot appear inside ` delimiters without
 * breaking the span). Newlines and control characters are removed.
 */
function sanitizeInline(s: string): string {
	// Remove backticks, newlines, carriage returns, and control characters
	return s.replace(/[`\n\r\x00-\x1f\x7f]/g, "").trim();
}
