import { describe, expect, it, vi } from "vitest";
import {
	cancelBackgroundReview,
	formatBackgroundReviewStatus,
	getBackgroundReview,
	startBackgroundReview,
} from "./background-review.js";

const result = {
	status: "done" as const,
	verdict: "Approve",
	counts: { total: 2 },
	healthScore: 94,
};

describe("background review tracking", () => {
	it("tracks completion and exposes a concise status", async () => {
		const onComplete = vi.fn();
		const record = startBackgroundReview(
			"background-test-done",
			async () => ({ details: { result: result as never } }),
			onComplete,
		);

		expect(record.status).toBe("running");
		await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith(result));

		const completed = getBackgroundReview(record.id);
		expect(completed?.status).toBe("done");
		expect(formatBackgroundReviewStatus(completed!)).toContain(
			"Approve · 2 findings · score 94/100",
		);
	});

	it("cancels a running task without allowing late completion to win", async () => {
		let resolveTask: (() => void) | undefined;
		let taskSignal: AbortSignal | undefined;
		const task = new Promise<{ details: { result: never } }>((resolve) => {
			resolveTask = () => resolve({ details: { result: undefined as never } });
		});
		const record = startBackgroundReview("background-test-cancel", (signal) => {
			taskSignal = signal;
			return task;
		});

		await vi.waitFor(() => expect(taskSignal).toBeDefined());
		const cancelled = cancelBackgroundReview(record.id);
		if (!cancelled) throw new Error("Expected a cancellable background review");
		expect(cancelled.status).toBe("cancelled");
		expect(taskSignal?.aborted).toBe(true);
		resolveTask?.();
		await Promise.resolve();
		expect(getBackgroundReview(record.id)?.status).toBe("cancelled");
		expect(formatBackgroundReviewStatus(cancelled)).toContain("cancelled");
	});

	it("does not evict running jobs when the record limit is exceeded", () => {
		const ids: string[] = [];
		for (let index = 0; index < 51; index++) {
			const id = `background-test-running-${index}`;
			ids.push(id);
			startBackgroundReview(id, () => new Promise(() => undefined));
		}

		expect(getBackgroundReview(ids[0])).toBeDefined();
		for (const id of ids) cancelBackgroundReview(id);
	});

	it("records task failures and exposes them in status", async () => {
		const onError = vi.fn();
		const record = startBackgroundReview(
			"background-test-error",
			async () => {
				throw new Error("scope failed");
			},
			undefined,
			onError,
		);

		await vi.waitFor(() => expect(onError).toHaveBeenCalled());
		const failed = getBackgroundReview(record.id);
		expect(failed?.status).toBe("error");
		expect(formatBackgroundReviewStatus(failed!)).toContain("scope failed");
	});
});
