import type { ReviewJob } from "./review-manager.js";
import type { Finding, Severity, SynthesisResult } from "./types.js";

export interface ReviewResultTarget {
	readonly mode?: string;
	readonly label?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface ReviewResultCounts {
	readonly total: number;
	readonly critical: number;
	readonly high: number;
	readonly medium: number;
	readonly low: number;
	readonly nit: number;
}

export interface ReviewValidationIssue {
	readonly findingIndex: number;
	readonly reason: string;
	readonly finding?: unknown;
}

export interface ReviewResult {
	readonly jobId: string;
	readonly clean: boolean;
	readonly status: ReviewJob["overallStatus"];
	readonly verdict: SynthesisResult["verdict"];
	readonly target?: ReviewResultTarget;
	readonly reportPath?: string;
	readonly files: string[];
	readonly counts: ReviewResultCounts;
	readonly findings: Finding[];
	readonly summary: string;
	readonly errors: string[];
	readonly validationIssues: ReviewValidationIssue[];
}

export interface BuildReviewResultOptions {
	readonly target?: ReviewResultTarget;
}

const SEVERITIES: readonly Severity[] = [
	"critical",
	"high",
	"medium",
	"low",
	"nit",
];
const SEVERITY_SET = new Set<Severity>(SEVERITIES);

export function buildReviewResult(
	job: ReviewJob,
	options: BuildReviewResultOptions = {},
): ReviewResult {
	const synthesis = job.synthesisResult;
	const scope = new Set(job.files.map(normalizePath));
	const validation = validateFindings(synthesis?.findings ?? [], scope);
	const counts = countFindings(validation.findings);
	const errors = collectErrors(job);
	const verdict = synthesis?.verdict ?? "Request changes";
	const status = job.overallStatus;
	const clean =
		status === "done" &&
		errors.length === 0 &&
		validation.findings.length === 0 &&
		verdict === "Approve";

	return {
		jobId: job.id,
		clean,
		status,
		verdict,
		...(options.target ? { target: options.target } : {}),
		...(job.reviewPath ? { reportPath: job.reviewPath } : {}),
		files: [...job.files],
		counts,
		findings: validation.findings,
		summary: synthesis?.summary ?? "Review did not produce a synthesis result.",
		errors,
		validationIssues: validation.issues,
	};
}

export function validateFindings(
	findings: readonly Finding[],
	scope: ReadonlySet<string>,
): { findings: Finding[]; issues: ReviewValidationIssue[] } {
	const valid: Finding[] = [];
	const issues: ReviewValidationIssue[] = [];

	findings.forEach((finding, index) => {
		const issue = validateFinding(finding, index, scope);
		if (issue) {
			issues.push(issue);
			return;
		}
		valid.push({ ...finding, file: normalizePath(finding.file) });
	});

	return { findings: valid, issues };
}

function validateFinding(
	finding: Finding,
	index: number,
	scope: ReadonlySet<string>,
): ReviewValidationIssue | null {
	const file = normalizePath(finding.file);
	if (!isSafeRelativePath(file)) {
		return issue(index, "unsafe or missing file path", finding);
	}
	if (!scope.has(file)) {
		return issue(index, `out-of-scope file: ${file}`, finding);
	}
	if (!SEVERITY_SET.has(finding.severity)) {
		return issue(
			index,
			`invalid severity: ${String(finding.severity)}`,
			finding,
		);
	}
	if (finding.line !== undefined && !isPositiveInteger(finding.line)) {
		return issue(index, `invalid line: ${String(finding.line)}`, finding);
	}
	for (const field of [
		"category",
		"summary",
		"detail",
		"suggestion",
	] as const) {
		if (
			typeof finding[field] !== "string" ||
			finding[field].trim().length === 0
		) {
			return issue(index, `missing ${field}`, finding);
		}
	}
	return null;
}

function issue(
	findingIndex: number,
	reason: string,
	finding: unknown,
): ReviewValidationIssue {
	return { findingIndex, reason, finding };
}

function countFindings(findings: readonly Finding[]): ReviewResultCounts {
	return {
		total: findings.length,
		critical: findings.filter((f) => f.severity === "critical").length,
		high: findings.filter((f) => f.severity === "high").length,
		medium: findings.filter((f) => f.severity === "medium").length,
		low: findings.filter((f) => f.severity === "low").length,
		nit: findings.filter((f) => f.severity === "nit").length,
	};
}

function collectErrors(job: ReviewJob): string[] {
	const errors: string[] = [];
	for (const lens of job.lenses) {
		const state = job.states.get(lens);
		if (state?.status === "error") {
			errors.push(`${lens}: ${state.errorMessage ?? "lens failed"}`);
		}
	}
	if (job.synthesisStatus === "error") {
		errors.push(
			`synthesis: ${job.synthesisResult?.summary ?? "synthesis failed"}`,
		);
	}
	return errors;
}

function normalizePath(file: string): string {
	return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSafeRelativePath(file: string): boolean {
	if (!file || file.trim().length === 0) return false;
	if (file.startsWith("/") || file.startsWith("\\")) return false;
	if (/^[A-Za-z]:[\\/]/.test(file)) return false;
	if (/[\x00-\x1f\x7f]/.test(file)) return false;
	const parts = file.split("/");
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}
