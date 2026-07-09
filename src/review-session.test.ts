import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyReviewState, setReviewInProgress } from "./review-session.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
	const ctx = {
		hasUI: true,
		ui: {
			setWidget: vi.fn(),
		},
		sessionManager: {
			getBranch: vi.fn().mockReturnValue([]),
		},
		...overrides,
	} as any;
	return ctx;
}

describe("review session state", () => {
	beforeEach(() => {
		setReviewInProgress(false);
		vi.clearAllMocks();
	});

	it("shows the review widget when a review is in progress", () => {
		const ctx = makeCtx();
		setReviewInProgress(true);

		applyReviewState(ctx);

		expect(ctx.ui.setWidget).toHaveBeenCalledWith("drykiss-review-session", [
			"DRYKISS review in progress",
		]);
	});

	it("hides the review widget when no review is in progress", () => {
		const ctx = makeCtx();
		setReviewInProgress(false);

		applyReviewState(ctx);

		expect(ctx.ui.setWidget).toHaveBeenCalledWith("drykiss-review-session", undefined);
	});

	it("does not touch the widget when the UI is unavailable", () => {
		const ctx = makeCtx({ hasUI: false });
		setReviewInProgress(true);

		applyReviewState(ctx);

		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});
});
