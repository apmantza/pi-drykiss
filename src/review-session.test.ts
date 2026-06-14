import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	applyReviewState,
	clearReviewSession,
	getReviewOriginId,
	isReviewInProgress,
	returnFromReviewSession,
	setReviewInProgress,
	startReviewSession,
} from "./review-session.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
	const ctx = {
		hasUI: true,
		ui: {
			setWidget: vi.fn(),
			setEditorText: vi.fn(),
		},
		sessionManager: {
			getLeafId: vi.fn().mockReturnValue("leaf-1"),
			getEntries: vi.fn().mockReturnValue([
				{
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "hello" },
				},
			]),
			getBranch: vi.fn().mockReturnValue([]),
		},
		navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
		...overrides,
	} as any;
	return ctx;
}

function makePi() {
	return { appendEntry: vi.fn() } as any;
}

describe("review session state", () => {
	beforeEach(() => {
		clearReviewSession(makePi(), makeCtx());
		vi.clearAllMocks();
	});

	it("restores active review state from the current branch", () => {
		const ctx = makeCtx({
			sessionManager: {
				getBranch: vi.fn().mockReturnValue([
					{
						type: "custom",
						customType: "drykiss-review-session",
						data: { active: true, originId: "origin-1" },
					},
				]),
			},
		});

		applyReviewState(ctx);

		expect(getReviewOriginId()).toBe("origin-1");
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("drykiss-review", [
			"DRYKISS review session active",
		]);
	});

	it("starts an isolated review branch and persists active state", async () => {
		const pi = makePi();
		const ctx = makeCtx();

		const result = await startReviewSession(pi, ctx);

		expect(result).toEqual({
			success: true,
			originId: "leaf-1",
			navigated: true,
		});
		expect(ctx.navigateTree).toHaveBeenCalledWith("user-1", {
			summarize: false,
			label: "drykiss-review",
		});
		expect(ctx.ui.setEditorText).toHaveBeenCalledWith("");
		expect(pi.appendEntry).toHaveBeenCalledWith("drykiss-review-session", {
			active: true,
			originId: "leaf-1",
		});
	});

	it("returns to the origin and clears active state", async () => {
		const pi = makePi();
		const ctx = makeCtx();
		await startReviewSession(pi, ctx);
		vi.clearAllMocks();

		const result = await returnFromReviewSession(pi, ctx);

		expect(result).toEqual({ success: true });
		expect(ctx.navigateTree).toHaveBeenCalledWith("leaf-1", {
			summarize: false,
		});
		expect(pi.appendEntry).toHaveBeenCalledWith("drykiss-review-session", {
			active: false,
			originId: undefined,
		});
		expect(getReviewOriginId()).toBeUndefined();
	});

	it("tracks review in-progress state for the widget", () => {
		const ctx = makeCtx({
			sessionManager: {
				getBranch: vi.fn().mockReturnValue([
					{
						type: "custom",
						customType: "drykiss-review-session",
						data: { active: true, originId: "origin-1" },
					},
				]),
			},
		});

		setReviewInProgress(true);
		applyReviewState(ctx);

		expect(isReviewInProgress()).toBe(true);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("drykiss-review", [
			"DRYKISS review in progress",
		]);
	});
});
