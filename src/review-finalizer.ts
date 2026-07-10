import type { Finding, SynthesisResult } from "./types.js";

export type ReviewStatus =
	| "done"
	| "incomplete"
	| "error"
	| "validation-degraded";

export type CodeRisk =
	| "clean"
	| "comments"
	| "request-changes"
	| "security-review";

export type GateStatus = "pass" | "warn" | "fail";

export interface ReviewQualityGate {
	readonly status: GateStatus;
	readonly threshold: number;
	readonly score: number;
	readonly reasons: string[];
}

export interface ReviewOutcome {
	readonly reviewStatus: ReviewStatus;
	readonly codeRisk: CodeRisk;
	readonly qualityGate: ReviewQualityGate;
	readonly verdict: SynthesisResult["verdict"];
	readonly verdictSource: "deterministic";
	readonly clean: boolean;
}

export function finalizeReviewOutcome(options: {
	findings: readonly Finding[];
	errors: readonly string[];
	validationIssues: readonly unknown[];
	healthScore: number;
	qualityGateThreshold?: number;
}): ReviewOutcome {
	const threshold = options.qualityGateThreshold ?? 70;
	const reviewStatus = getReviewStatus(
		options.errors,
		options.validationIssues,
	);
	const codeRisk = getCodeRisk(options.findings);
	const verdict = getVerdict(codeRisk);
	const qualityGate = getQualityGate({
		reviewStatus,
		codeRisk,
		healthScore: options.healthScore,
		threshold,
	});

	return {
		reviewStatus,
		codeRisk,
		qualityGate,
		verdict,
		verdictSource: "deterministic",
		clean: reviewStatus === "done" && codeRisk === "clean",
	};
}

function getReviewStatus(
	errors: readonly string[],
	validationIssues: readonly unknown[],
): ReviewStatus {
	if (errors.length > 0) return "error";
	if (validationIssues.length > 0) return "validation-degraded";
	return "done";
}

function getCodeRisk(findings: readonly Finding[]): CodeRisk {
	const actionable = findings.filter((finding) => finding.action !== "ignore");
	const blocking = actionable.filter(
		(finding) => finding.severity === "critical" || finding.severity === "high",
	);
	if (
		blocking.some(
			(finding) =>
				finding.lens === "security" ||
				finding.source?.split("+").includes("security"),
		)
	) {
		return "security-review";
	}
	if (blocking.length > 0) return "request-changes";
	if (actionable.length > 0) return "comments";
	return "clean";
}

function getVerdict(codeRisk: CodeRisk): SynthesisResult["verdict"] {
	if (codeRisk === "security-review") return "Needs security review";
	if (codeRisk === "request-changes") return "Request changes";
	return "Approve";
}

function getQualityGate(options: {
	reviewStatus: ReviewStatus;
	codeRisk: CodeRisk;
	healthScore: number;
	threshold: number;
}): ReviewQualityGate {
	const reasons: string[] = [];

	if (options.reviewStatus === "error") {
		reasons.push("review execution failed");
		return {
			status: "fail",
			threshold: options.threshold,
			score: options.healthScore,
			reasons,
		};
	}
	if (options.reviewStatus === "validation-degraded") {
		reasons.push("one or more synthesized findings failed validation");
		return {
			status: "warn",
			threshold: options.threshold,
			score: options.healthScore,
			reasons,
		};
	}
	if (options.healthScore < options.threshold) {
		reasons.push(
			`health score is below the configured threshold (${options.threshold})`,
		);
	}
	if (options.codeRisk === "security-review") {
		reasons.push("active security finding requires review");
	} else if (options.codeRisk === "request-changes") {
		reasons.push("active blocking finding requires changes");
	}

	return {
		status: reasons.length > 0 ? "fail" : "pass",
		threshold: options.threshold,
		score: options.healthScore,
		reasons,
	};
}
