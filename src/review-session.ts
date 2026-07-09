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
	// IMPORTANT: this legacy flag-driven widget must NOT use the
	// "drykiss-review" key. That key is owned exclusively by
	// ReviewProgressWidget, which renders the live progress bar (running
	// state + completed summary). The old slash-command "review in
	// progress" feature was removed, so this seam is effectively dead
	// (reviewInProgress is never set true in production), but it must
	// still avoid touching the progress widget's key: previously it
	// called setWidget("drykiss-review", undefined) on every completion,
	// which unregistered the progress bar mid-render. For fast reviews
	// (e.g. mode=files) the whole run finished within a frame or two, so
	// that unregister won the race and the bar never appeared.
	if (!active) {
		ctx.ui.setWidget("drykiss-review-session", undefined);
		return;
	}

	ctx.ui.setWidget("drykiss-review-session", ["DRYKISS review in progress"]);
}
