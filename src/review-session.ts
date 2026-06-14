import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DRYKISS_REVIEW_STATE_TYPE = "drykiss-review-session";

type DrykissReviewSessionState = {
	active: boolean;
	originId?: string;
};

let reviewOriginId: string | undefined;
let reviewInProgress = false;

export function setReviewInProgress(inProgress: boolean): void {
	reviewInProgress = inProgress;
}

export function isReviewInProgress(): boolean {
	return reviewInProgress;
}

export function getReviewOriginId(): string | undefined {
	return reviewOriginId;
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
	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		setReviewWidget(ctx, true);
		return;
	}
	reviewOriginId = undefined;
	setReviewWidget(ctx, false);
}

export function setReviewWidget(ctx: ExtensionContext, active: boolean): void {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget("drykiss-review", undefined);
		return;
	}

	const message = reviewInProgress
		? "DRYKISS review in progress"
		: "DRYKISS review session active";
	ctx.ui.setWidget("drykiss-review", [message]);
}

export function persistReviewState(pi: ExtensionAPI, active: boolean): void {
	pi.appendEntry(DRYKISS_REVIEW_STATE_TYPE, {
		active,
		originId: reviewOriginId,
	});
}

export function clearReviewSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	reviewOriginId = undefined;
	reviewInProgress = false;
	setReviewWidget(ctx, false);
	persistReviewState(pi, false);
}

export async function startReviewSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<
	| { success: true; originId: string; navigated: boolean }
	| { success: false; error: string }
> {
	if (reviewOriginId) {
		return {
			success: false,
			error: "Already in a DRYKISS review. Use /drykiss-end to finish first.",
		};
	}

	let originId = ctx.sessionManager.getLeafId() ?? undefined;
	if (!originId) {
		pi.appendEntry("drykiss-review-anchor", {
			createdAt: new Date().toISOString(),
		});
		originId = ctx.sessionManager.getLeafId() ?? undefined;
	}
	if (!originId) {
		return { success: false, error: "Failed to determine review origin." };
	}

	const lockedOriginId = originId;
	reviewOriginId = lockedOriginId;

	// Try to navigate to the first user message to create an isolated review branch.
	const entries = ctx.sessionManager.getEntries();
	const firstUserMessage = entries.find(
		(e) => e.type === "message" && e.message.role === "user",
	);

	let navigated = false;
	if (firstUserMessage) {
		const result = await ctx.navigateTree(firstUserMessage.id, {
			summarize: false,
			label: "drykiss-review",
		});
		if (result.cancelled) {
			reviewOriginId = undefined;
			return { success: false, error: "Review branch creation cancelled." };
		}
		ctx.ui.setEditorText("");
		navigated = true;
	}

	// Restore origin after navigation events may have reset it.
	reviewOriginId = lockedOriginId;
	setReviewWidget(ctx, true);
	persistReviewState(pi, true);

	return { success: true, originId: lockedOriginId, navigated };
}

export async function returnFromReviewSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	options: { summarize?: boolean } = {},
): Promise<{ success: boolean; error?: string }> {
	const originId = getActiveReviewOrigin(ctx);
	if (!originId) {
		return {
			success: false,
			error: "Not in a DRYKISS review session (use /drykiss --branch first).",
		};
	}

	const result = await ctx.navigateTree(originId, {
		summarize: options.summarize ?? false,
	});
	if (result.cancelled) {
		return { success: false, error: "Return cancelled." };
	}

	clearReviewSession(pi, ctx);
	return { success: true };
}

function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
	if (reviewOriginId) {
		return reviewOriginId;
	}
	const state = getReviewState(ctx);
	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		return reviewOriginId;
	}
	if (state?.active) {
		setReviewWidget(ctx, false);
	}
	return undefined;
}
