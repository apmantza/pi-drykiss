import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Finding, ReviewLens, Severity } from "./types.js";
import type { ReviewResult } from "./review-result.js";
import type { ReviewScope } from "./review-scope.js";
import { finalizeReviewOutcome } from "./review-finalizer.js";
import { formatReviewResultCompact } from "./compact-format.js";
import { formatReviewResultForTool } from "./review-output.js";
import { loadValidatorSystemPrompt } from "./validator.js";

interface DeepReviewCommandParams {
	readonly deep: ReviewLens;
	readonly deepPasses?: number;
	readonly deepMinVotes?: number;
	readonly deepValidate?: boolean;
	readonly model?: string;
	readonly format?: "compact" | "structured";
}

type ToolUpdate = (result: {
	content: Array<{ type: "text"; text: string }>;
}) => void;

/** Run the Bugbot-style deep-review pipeline for one lens. */
export async function runDeepAutoreview(
	ctx: ExtensionContext,
	scope: ReviewScope,
	params: DeepReviewCommandParams,
	onUpdate: ToolUpdate | undefined,
	signal: AbortSignal | undefined,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { result: ReviewResult };
}> {
	const {
		runDeepReview,
		buildModelPlan,
		loadDeepPassSystemPrompt,
		makePiCallerAdapter,
	} = await import("./deep-review.js");
	const { findModelByHint } = await import("./model-utils.js");

	const available = ctx.modelRegistry.getAvailable();
	const sessionModel = findModelByHint(available, params.model ?? "haiku");
	if (!sessionModel) {
		throw new Error("No model available for deep-review pipeline.");
	}
	if (params.deep === "all") {
		throw new Error(
			"Deep mode requires a specific lens name (e.g. 'security'), not 'all'.",
		);
	}

	const { composeLensPrompt } = await import("./prompt-composer.js");
	const lensSystem = await composeLensPrompt(params.deep, {});
	const diffBlock = formatDiffsForDeepAutoreview(scope);
	const baseUserPrompt = `# Deep Review (${params.deep} lens)\n\n${diffBlock}`;
	const passSystem = await loadDeepPassSystemPrompt();
	const validatorSystem = await loadValidatorSystemPrompt();
	const config: import("./deep-review.js").DeepReviewConfig = {
		passes: params.deepPasses ?? 5,
		concurrency: params.deepPasses ?? 5,
		temperature: 0.4,
		maxFindings: 50,
		minVotes: params.deepMinVotes ?? 2,
		...(signal ? { signal } : {}),
	};
	const plan = buildModelPlan({
		passModelKey: sessionModel.id,
		passModelLabel: sessionModel.name,
		validatorModelKey: sessionModel.id,
		validatorModelLabel: sessionModel.name,
		passes: config.passes,
	});
	const caller = makePiCallerAdapter(ctx, sessionModel);
	const onStage = (stage: string) => {
		onUpdate?.({
			content: [{ type: "text", text: `Deep review: ${stage}...` }],
		});
	};
	const result = await runDeepReview({
		baseUserPrompt,
		config,
		plan,
		passSystem: lensSystem + "\n\n" + passSystem,
		validatorSystem,
		caller,
		hooks: { onStage },
	});

	const mapSeverity = (
		deep: import("./deep-review.js").DeepSeverity,
		votes: number,
	): Severity => {
		if (deep === "blocker") return "critical";
		if (deep === "warning") return "high";
		return votes >= 2 ? "medium" : "low";
	};
	const findings: Finding[] = result.findings.map((finding) => ({
		file: finding.file,
		...(finding.line !== undefined ? { line: finding.line } : {}),
		severity: mapSeverity(finding.severity, finding.votes),
		category: finding.category ?? "Deep Review Finding",
		summary: finding.message,
		detail: finding.message,
		suggestion: "",
		consequence: undefined,
		source: params.deep as string,
		fixability: undefined,
		confidence: finding.votes >= 2 ? "confirmed" : "likely",
		lens: params.deep,
		riskCode: undefined,
		action: "fix",
		riskLevel: finding.severity === "blocker" ? "high" : "medium",
		priority: undefined,
		_validatorVerdict: finding.verdict === "real" ? "real" : "unverified",
		_validatorJustification: finding.justification,
	}));
	const critical = findings.filter(
		(finding) => finding.severity === "critical",
	).length;
	const high = findings.filter((finding) => finding.severity === "high").length;
	const medium = findings.filter(
		(finding) => finding.severity === "medium",
	).length;
	const low = findings.filter((finding) => finding.severity === "low").length;
	const nit = findings.filter((finding) => finding.severity === "nit").length;
	const scoreBreakdown = {
		critical,
		warning: high + medium,
		suggestion: low + nit,
	};
	const healthScore = Math.max(
		0,
		100 -
			scoreBreakdown.critical * 15 -
			scoreBreakdown.warning * 5 -
			scoreBreakdown.suggestion,
	);
	const outcome = finalizeReviewOutcome({
		findings,
		errors: [],
		validationIssues: [],
		healthScore,
	});
	const reviewResult: ReviewResult = {
		jobId: "deep",
		clean: outcome.clean,
		status: "done",
		reviewStatus: outcome.reviewStatus,
		codeRisk: outcome.codeRisk,
		qualityGate: outcome.qualityGate,
		verdict: outcome.verdict,
		verdictSource: outcome.verdictSource,
		files: scope.files.map((file) => file.path),
		counts: {
			total: findings.length,
			critical,
			high,
			medium,
			low,
			nit,
			suppressed: 0,
			previouslyRejected: 0,
			validatorReal: result.findings.length,
			validatorFalsePositive: result.rejected.length,
			validatorUnverified: 0,
		},
		findings,
		summary: `Deep review (${params.deep}) found ${findings.length} finding(s) across ${result.telemetry.passes} adversarial passes.`,
		errors: [],
		validationIssues: [],
		healthScore,
		scoreBreakdown,
	};
	const text =
		(params.format ?? "compact") === "compact"
			? formatReviewResultCompact(reviewResult, { qualityGateThreshold: 70 })
			: formatReviewResultForTool(reviewResult, { qualityGateThreshold: 70 });
	return {
		content: [{ type: "text", text }],
		details: { result: reviewResult },
	};
}

function formatDiffsForDeepAutoreview(scope: ReviewScope): string {
	if (scope.diffs.size === 0) return "(no diff)";
	const blocks: string[] = [];
	const perFileBudget = 8_000;
	for (const [file, diff] of scope.diffs) {
		const truncated =
			diff.length > perFileBudget
				? `${diff.slice(0, perFileBudget)}\n... (truncated)`
				: diff;
		blocks.push(`### ${file}\n\n${truncated}`);
	}
	return `# Diff Under Review\n\n${blocks.join("\n\n")}`;
}
