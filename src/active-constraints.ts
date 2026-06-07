/**
 * active-constraints.ts — Format a RiskTargeting config into a human-readable
 * "Active Constraints" block that gets injected into the lens and synthesis
 * system prompts via the `{{active_constraints}}` placeholder in
 * `src/prompts/_shared/active-constraints.md`.
 *
 * The output is plain English so the LLM can act on it directly. The
 * composer does a simple `{{key}}` substitution — no template engine.
 */
import type { RiskTargeting } from "./config.js";
import { RISK_CODES } from "./prompts/risk-codes.js";

/**
 * Return a multi-line string describing the active risk-targeting
 * configuration. Returns an empty string when no constraints are active
 * (the composer treats that as "don't include the active-constraints.md
 * fragment at all").
 */
export function buildActiveConstraints(rt: RiskTargeting | undefined): string {
	if (!rt) return "";
	const lines: string[] = [];

	if (rt.disable && rt.disable.length > 0) {
		lines.push(
			`- DISABLED risk codes (do NOT report findings of these types): ${rt.disable.map(formatCode).join(", ")}`,
		);
	}

	if (rt.focus && rt.focus.length > 0) {
		lines.push(
			`- FOCUSED risk codes (report ONLY findings of these types): ${rt.focus.map(formatCode).join(", ")}`,
		);
	}

	if (rt.severity && rt.severity.length > 0) {
		lines.push("- Severity overrides (applied to matching risk codes):");
		for (const rule of rt.severity) {
			const def = RISK_CODES[rule.riskCode as keyof typeof RISK_CODES];
			const name = def ? def.name : rule.riskCode;
			lines.push(
				`  - ${rule.riskCode} (${name}): report as "${rule.to}" instead of the default`,
			);
		}
	}

	if (rt.ignore && rt.ignore.length > 0) {
		lines.push(
			`- IGNORED file globs (do NOT report findings in files matching): ${rt.ignore.join(", ")}`,
		);
	}

	return lines.join("\n");
}

/** Format a risk code as "K1 (KISS violation)" for LLM readability. */
function formatCode(code: string): string {
	const def = RISK_CODES[code as keyof typeof RISK_CODES];
	return def ? `${code} (${def.name})` : code;
}
