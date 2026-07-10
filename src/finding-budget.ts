import type { Finding, Severity } from "./types.js";

export interface FindingBudget {
	readonly maxFindings?: number;
	readonly maxNits?: number;
}

export interface FindingBudgetResult {
	readonly findings: Finding[];
	readonly omittedLowPriorityCount: number;
	readonly omittedNitCount: number;
	readonly applied: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	nit: 4,
};

const PRIORITY_ORDER: Record<NonNullable<Finding["priority"]>, number> = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3,
};

export function applyFindingBudget(
	findings: readonly Finding[],
	budget: FindingBudget | undefined,
): FindingBudgetResult {
	const maxFindings = budget?.maxFindings;
	const maxNits = budget?.maxNits;
	if (maxFindings === undefined && maxNits === undefined) {
		return {
			findings: [...findings],
			omittedLowPriorityCount: 0,
			omittedNitCount: 0,
			applied: false,
		};
	}

	const ranked = [...findings].sort(compareFindings);
	const kept: Finding[] = [];
	let budgetedCount = 0;
	let keptNits = 0;
	let omittedLowPriorityCount = 0;
	let omittedNitCount = 0;

	for (const finding of ranked) {
		if (isExempt(finding)) {
			kept.push(finding);
			continue;
		}
		if (
			finding.severity === "nit" &&
			maxNits !== undefined &&
			keptNits >= maxNits
		) {
			omittedNitCount += 1;
			continue;
		}
		if (maxFindings !== undefined && budgetedCount >= maxFindings) {
			if (finding.severity === "nit") omittedNitCount += 1;
			else omittedLowPriorityCount += 1;
			continue;
		}
		kept.push(finding);
		budgetedCount += 1;
		if (finding.severity === "nit") keptNits += 1;
	}

	return {
		findings: kept,
		omittedLowPriorityCount,
		omittedNitCount,
		applied: true,
	};
}

function isExempt(finding: Finding): boolean {
	return (
		finding.severity === "critical" ||
		(finding.lens === "security" && finding._validatorVerdict === "real")
	);
}

function compareFindings(left: Finding, right: Finding): number {
	return (
		SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
		PRIORITY_ORDER[left.priority ?? "P3"] -
			PRIORITY_ORDER[right.priority ?? "P3"] ||
		validatorRank(right) - validatorRank(left) ||
		(right._bucketVotes ?? 1) - (left._bucketVotes ?? 1) ||
		confidenceRank(right) - confidenceRank(left) ||
		(left.line ?? Number.MAX_SAFE_INTEGER) -
			(right.line ?? Number.MAX_SAFE_INTEGER) ||
		left.file.localeCompare(right.file)
	);
}

function validatorRank(finding: Finding): number {
	return finding._validatorVerdict === "real" ? 1 : 0;
}

function confidenceRank(finding: Finding): number {
	if (finding.confidence === "confirmed") return 3;
	if (finding.confidence === "likely") return 2;
	return 1;
}
