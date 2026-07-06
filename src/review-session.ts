import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DRYKISS_REVIEW_STATE_TYPE = "drykiss-review-session";

type DrykissReviewSessionState = {
	active: boolean;
	originId?: string;
};

let reviewInProgress = false;

export function setReviewInProgress(inProgress: boolean): void {
	reviewInProgress = inProgress;
}

export function getReviewState(
	ctx: ExtensionContext,
): DrykissReviewSessionState | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type === "custom" &&
			entry.customType === DRYKISS_REVIEW_STATE_TYPE
		) {
			return entry.data as DrykissReviewSessionState | undefined;
		}
	}
	return undefined;
}

export function applyReviewState(ctx: ExtensionContext): void {
	const state = getReviewState(ctx);
	// The isolated review session feature was removed along with the
	// slash commands. The widget is now driven only by the in-progress
	// flag, so the state is intentionally ignored here.
	setReviewWidget(ctx, reviewInProgress);
}

export function setReviewWidget(ctx: ExtensionContext, active: boolean): void {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget("drykiss-review", undefined);
		return;
	}

	ctx.ui.setWidget("drykiss-review", ["DRYKISS review in progress"]);
}
