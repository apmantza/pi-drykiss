import type { ReviewResult } from "./review-result.js";

/** Format the structured result for the tool's compact text response. */
export function formatReviewResultForTool(
	result: ReviewResult,
	options?: { qualityGateThreshold?: number },
): string {
	const threshold = options?.qualityGateThreshold ?? 70;
	const suppressedStr =
		result.counts.suppressed > 0
			? `, ${result.counts.suppressed} suppressed`
			: "";
	const validationDropped =
		result.findings.length === 0 &&
		result.counts.total === 0 &&
		result.validationIssues.length > 0;
	const validationStr = validationDropped
		? ` (raw synthesis output preserved: ${result.validationIssues.length} finding(s) dropped during validation — see issues below)`
		: "";
	const validatorStr =
		result.counts.validatorFalsePositive === undefined
			? ""
			: ` · validator: ${result.counts.validatorReal ?? 0} confirmed, ${result.counts.validatorFalsePositive} discarded, ${result.counts.validatorUnverified ?? 0} unverified`;
	const findingsLine = `findings: ${result.counts.total} (${result.counts.critical} critical, ${result.counts.high} high, ${result.counts.medium} medium, ${result.counts.low} low, ${result.counts.nit} nit${suppressedStr})${validationStr}${validatorStr}`;
	const scoreLine = `health score: ${result.healthScore}/100`;
	const breakdown = result.scoreBreakdown;
	const scoreDetail = `(critical: ${breakdown.critical}, warning: ${breakdown.warning}, suggestion: ${breakdown.suggestion})`;
	let trendLine = "";
	if (result.prevScore !== null && result.prevScore !== undefined) {
		const diff = result.healthScore - result.prevScore;
		const sign = diff >= 0 ? "+" : "";
		trendLine = `trend: ${result.prevScore} → ${result.healthScore} (${sign}${diff})`;
	}
	const qualityGateStatus =
		result.qualityGate?.status ??
		(result.healthScore < threshold ? "fail" : "pass");
	let qualityGate = "⛔ quality gate: FAIL";
	if (qualityGateStatus === "pass") qualityGate = "✅ quality gate: pass";
	else if (qualityGateStatus === "warn") qualityGate = "⚠️ quality gate: WARN";

	const lines = [
		`DRYKISS autoreview ${result.clean ? "clean" : "completed with findings"}`,
		`target: ${result.target?.label ?? "unknown"}`,
		`review status: ${result.reviewStatus ?? result.status}`,
		`code risk: ${result.codeRisk ?? "unknown"}`,
		`verdict: ${result.verdict}`,
		findingsLine,
		scoreLine,
		scoreDetail,
	];
	if (trendLine) lines.push(trendLine);
	lines.push(qualityGate);
	if (result.validationIssues.length > 0) {
		lines.push("", `validation issues (${result.validationIssues.length}):`);
		for (const issue of result.validationIssues.slice(0, 5)) {
			lines.push(`  - finding #${issue.findingIndex}: ${issue.reason}`);
		}
		if (result.validationIssues.length > 5) {
			lines.push(`  ... and ${result.validationIssues.length - 5} more`);
		}
	}
	if (result.mermaidGraph) {
		lines.push("", "=== Dependency Graph ===", result.mermaidGraph);
	}
	if (result.reportPath) lines.push(`report: ${result.reportPath}`);
	if (result.validatorError)
		lines.push(`validator error: ${result.validatorError}`);
	if (result.errors.length > 0)
		lines.push(`errors: ${result.errors.join("; ")}`);
	if (result.validationIssues.length > 0) {
		lines.push(`validation issues: ${result.validationIssues.length}`);
	}
	lines.push("", result.summary);
	if (result.findings.length > 0) {
		lines.push("", JSON.stringify(result.findings, null, 2));
	}
	if (result.discardedFindings && result.discardedFindings.length > 0) {
		lines.push(
			"",
			`discarded findings (${result.discardedFindings.length}):`,
			JSON.stringify(result.discardedFindings, null, 2),
		);
	}
	return lines.join("\n");
}
