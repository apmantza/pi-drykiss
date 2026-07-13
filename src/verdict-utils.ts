export interface ParsedVerdict {
	readonly id: number;
	readonly verdict: "real" | "false-positive";
	readonly confidence: number;
	readonly justification?: string;
}

/** Normalize one model-emitted validator verdict record. */
export function parseVerdictRecord(
	record: Record<string, unknown>,
	unknownVerdict: "false-positive" | "skip",
): ParsedVerdict | undefined {
	if (typeof record.id !== "number" || !Number.isInteger(record.id)) {
		return undefined;
	}

	let verdict: ParsedVerdict["verdict"] | undefined;
	if (record.verdict === "real") verdict = "real";
	else if (record.verdict === "false-positive") verdict = "false-positive";
	else if (unknownVerdict === "false-positive") verdict = "false-positive";
	if (!verdict) return undefined;

	const confidence =
		typeof record.confidence === "number" && Number.isFinite(record.confidence)
			? Math.min(1, Math.max(0, record.confidence))
			: 0.5;
	const justification =
		typeof record.justification === "string"
			? record.justification.trim() || undefined
			: undefined;
	return { id: record.id, verdict, confidence, justification };
}
