import type { ReviewResult } from "./review-result.js";
import { logAutoreviewError } from "./logger.js";

export type BackgroundReviewStatus = "running" | "done" | "error" | "cancelled";

export interface BackgroundReviewRecord {
	readonly id: string;
	readonly startedAt: number;
	status: BackgroundReviewStatus;
	completedAt?: number;
	result?: ReviewResult;
	errorMessage?: string;
}

type BackgroundReviewTask = (
	signal: AbortSignal,
) => Promise<{ details?: { result?: ReviewResult } }>;

const MAX_RECORDS = 50;
const RETENTION_MS = 30 * 60 * 1000;
const records = new Map<string, BackgroundReviewRecord>();
const controllers = new Map<string, AbortController>();

/** Start a review without tying its lifetime to the invoking tool call. */
export function startBackgroundReview(
	id: string,
	task: BackgroundReviewTask,
	onComplete?: (result: ReviewResult) => void,
	onError?: (error: unknown) => void,
): BackgroundReviewRecord {
	pruneBackgroundReviews();
	const record: BackgroundReviewRecord = {
		id,
		startedAt: Date.now(),
		status: "running",
	};
	records.set(id, record);
	const controller = new AbortController();
	controllers.set(id, controller);

	void Promise.resolve()
		.then(() => task(controller.signal))
		.then((response) => {
			if (record.status === "cancelled") return;
			const result = response.details?.result;
			if (!result) {
				throw new Error("Background review returned no result.");
			}
			record.status = result.status === "error" ? "error" : "done";
			record.completedAt = Date.now();
			record.result = result;
			try {
				onComplete?.(result);
			} catch (error) {
				logAutoreviewError("background.on_complete_callback_error", error, {
					jobId: id,
				});
			}
		})
		.catch((error: unknown) => {
			if (record.status === "cancelled") return;
			record.status = "error";
			record.completedAt = Date.now();
			record.errorMessage =
				error instanceof Error ? error.message : String(error);
			try {
				onError?.(error);
			} catch (callbackError) {
				logAutoreviewError(
					"background.on_error_callback_error",
					callbackError,
					{ jobId: id },
				);
			}
		})
		.finally(() => {
			controllers.delete(id);
		});

	return record;
}

export function getBackgroundReview(
	id: string,
): BackgroundReviewRecord | undefined {
	pruneBackgroundReviews();
	return records.get(id);
}

export function cancelBackgroundReview(
	id: string,
): BackgroundReviewRecord | undefined {
	const record = getBackgroundReview(id);
	if (!record || record.status !== "running") return record;
	record.status = "cancelled";
	record.completedAt = Date.now();
	record.errorMessage = "Cancelled by user";
	controllers.get(id)?.abort();
	controllers.delete(id);
	return record;
}

export function formatBackgroundReviewStatus(
	record: BackgroundReviewRecord,
): string {
	if (record.status === "running") {
		return `DRYKISS background review running · job ${record.id}`;
	}
	if (record.status === "cancelled") {
		return `DRYKISS background review cancelled · job ${record.id}`;
	}
	if (record.status === "error") {
		return `DRYKISS background review failed · job ${record.id}${record.errorMessage ? ` · ${record.errorMessage}` : ""}`;
	}
	const result = record.result;
	if (!result) return `DRYKISS background review complete · job ${record.id}`;
	const score =
		typeof result.healthScore === "number"
			? ` · score ${result.healthScore}/100`
			: "";
	const target = result.target?.label ? ` · ${result.target.label}` : "";
	return `DRYKISS background review complete${target} · Verdict: ${result.verdict} · ${result.counts.total} findings${score} · job ${record.id}`;
}

function pruneBackgroundReviews(): void {
	const cutoff = Date.now() - RETENTION_MS;
	for (const [id, record] of records) {
		if (record.completedAt !== undefined && record.completedAt < cutoff) {
			records.delete(id);
		}
	}
	while (records.size > MAX_RECORDS) {
		const evictable = [...records.entries()].find(
			([, record]) => record.status !== "running",
		);
		if (!evictable) break;
		records.delete(evictable[0]);
	}
}
