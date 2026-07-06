import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	executeDrykissAutoreviewTool,
	DrykissAutoreviewParams,
} from "./review-command.js";
import { applyReviewState, setReviewInProgress } from "./review-session.js";
import { createEditTracker } from "./edit-tracker.js";
import { buildAutoInjectBlock } from "./auto-inject.js";
import { ReviewManager } from "./review-manager.js";
import { ReviewProgressWidget } from "./review-widget.js";
import { LOG_PREFIX } from "./constants.js";
import { toErrorMessage } from "./error-utils.js";

function warnExtensionError(
	action: string,
	err: unknown,
	ctx?: ExtensionContext,
): void {
	let text: string;
	try {
		text = `${LOG_PREFIX} Failed ${action}: ${toErrorMessage(err)}`;
	} catch {
		text = `${LOG_PREFIX} Failed ${action}: <unprintable error>`;
	}
	console.warn(text);
	try {
		ctx?.ui.notify(text, "warning");
	} catch (notifyErr) {
		console.warn(
			`${LOG_PREFIX} Failed to show warning notification: ${toErrorMessage(notifyErr)}`,
		);
	}
}

export default function (pi: ExtensionAPI): void {
	// ── Background review manager + live widget ────────────
	const widget = new ReviewProgressWidget();
	let lastContext: ExtensionContext | undefined;
	const manager = new ReviewManager(
		(_job) => {
			try {
				widget.setJobs(manager.listJobs());
			} catch (err) {
				warnExtensionError("updating review widget", err, lastContext);
			}
		},
		(_job) => {
			let hasRunningReview = false;
			try {
				const jobs = manager.listJobs();
				hasRunningReview = jobs.some((j) => j.overallStatus === "running");
				widget.setJobs(jobs);
			} catch (err) {
				warnExtensionError("handling completed review", err, lastContext);
			} finally {
				if (!hasRunningReview) {
					try {
						setReviewInProgress(false);
						if (lastContext) applyReviewState(lastContext);
					} catch (err) {
						warnExtensionError(
							"resetting review session state",
							err,
							lastContext,
						);
					}
				}
			}
		},
	);
	try {
		manager.startCleanup();
	} catch (err) {
		warnExtensionError("starting review cleanup timer", err, lastContext);
	}
	const editTracker = createEditTracker();

	// Grab UI context from tool executions so widget renders even when no
	// tool is active (matches pi-subagents pattern).
	pi.on("tool_execution_start", (_event: any, ctx: any) => {
		try {
			lastContext = ctx;
			widget.attach(ctx.ui);
			widget.setJobs(manager.listJobs());
		} catch (err) {
			warnExtensionError("updating review widget on tool start", err, ctx);
		}
	});

	pi.on("tool_execution_end", (event: any, ctx: any) => {
		try {
			if (event.isError) return;
			editTracker.trackEdit(
				event.toolName,
				event.result,
				event.args ?? event.input,
			);
		} catch (err) {
			warnExtensionError("tracking file edit", err, ctx);
		}
	});

	pi.on("turn_end", (event: any, ctx: any) => {
		try {
			editTracker.onTurnEnd(event.turnIndex ?? 0);
		} catch (err) {
			warnExtensionError("finalizing edit tracking for turn", err, ctx);
		}
	});

	pi.on("before_agent_start", (event: any, ctx: any) => {
		try {
			const edits = editTracker.getLastTurnEdits();
			if (!edits) return undefined;
			const autoInject = buildAutoInjectBlock(edits);
			editTracker.clearLastTurnEdits();
			return { systemPrompt: event.systemPrompt + autoInject };
		} catch (err) {
			warnExtensionError("building auto-inject prompt", err, ctx);
			return undefined;
		}
	});

	// Also grab UI context on session changes so tools can show widgets
	// and DRYKISS can restore isolated review-session state after reload/navigation.
	pi.on("session_start", (_event: any, ctx: any) => {
		try {
			lastContext = ctx;
			widget.attach(ctx.ui);
			applyReviewState(ctx);
		} catch (err) {
			warnExtensionError("restoring review state on session start", err, ctx);
		}
	});

	pi.on("session_tree", (_event: any, ctx: any) => {
		try {
			lastContext = ctx;
			applyReviewState(ctx);
		} catch (err) {
			warnExtensionError(
				"restoring review state on session tree change",
				err,
				ctx,
			);
		}
	});

	// ── drykiss_autoreview tool — Programmatic review ─────
	pi.registerTool({
		name: "drykiss_autoreview",
		label: "DRYKISS Autoreview",
		description:
			"Run a blocking multi-lens DRYKISS review over a git/PR/codebase target. Pick a scope: local (uncommitted), staged, branch (needs base), commit (needs SHA), pr (needs URL), full, or files (needs paths). Returns a stable structured ReviewResult.",
		promptSnippet:
			"Run a multi-lens DRYKISS autoreview over a git/PR/codebase target",
		promptGuidelines: [
			"Use drykiss_autoreview for closeout code reviews, git diff reviews, PR reviews, full-codebase scans, or when the user asks for autoreview.",
			"Pick exactly one scope via the `mode` field: 'local' for uncommitted changes, 'staged' for staged changes, 'branch' with `base` for branch reviews, 'commit' with `commit` for single commits, 'pr' with `pr` for GitHub PRs, 'full' for the entire codebase, 'files' with `files` for explicit paths. Omit `mode` to use a smart default (staged → local).",
			"Optional: pass `lens` (single lens or 'all') or `lenses` (array) to run a subset. Default is all lenses. Pass `lens: 'security'` for a focused single-lens review.",
			"Optional: pass `format: 'structured'` if you need the full markdown report; default 'compact' is one line per finding.",
			"Model selection, context mode, max files, validator, and deep mode are config-driven via ~/.pi/drykiss/config.json — not exposed as tool parameters.",
			"Treat drykiss_autoreview findings as advisory: verify real code before fixing, reject speculative findings, and rerun focused tests after any review-triggered fix.",
		],
		parameters: DrykissAutoreviewParams,

		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: any,
			ctx: any,
		) {
			return executeDrykissAutoreviewTool(
				params as any,
				ctx,
				pi,
				manager,
				signal,
				onUpdate,
			);
		},

		renderCall(args: any, theme: any) {
			let mode = args.mode;
			if (!mode) {
				mode = args.pr ? "pr" : args.files ? "files" : "local";
			}
			const target = args.pr ?? args.base ?? args.commit ?? "";
			const lensInfo = args.lens
				? ` ${args.lens}`
				: args.lenses
					? ` ${Array.isArray(args.lenses) ? args.lenses.join(",") : args.lenses}`
					: " all";
			return new Text(
				theme.fg("toolTitle", theme.bold("drykiss_autoreview ")) +
					theme.fg("accent", mode) +
					theme.fg("dim", `${target ? ` ${target}` : ""}${lensInfo}`),
				0,
				0,
			);
		},

		renderResult(result: any, _options: any, theme: any) {
			if (result.details?.phase === "scoping") {
				const text = result.content?.[0]?.text ?? "Preparing review scope…";
				return new Text(theme.fg("dim", text), 0, 0);
			}
			const review = result.details?.result;
			const progress = result.details?.progress;
			const clean = review?.clean === true;
			const counts = review?.counts ?? {};
			const icon = clean ? theme.fg("success", "✓") : theme.fg("warning", "◐");
			const hs = review?.healthScore;
			const hasScore = typeof hs === "number";
			let scoreText = "";
			if (hasScore) {
				const scoreColor =
					hs >= 80 ? "success" : hs >= 50 ? "warning" : "error";
				scoreText = theme.fg(scoreColor, `, score ${hs}/100`);
			}
			const summary =
				`${icon} ${theme.fg("accent", clean ? "clean" : "reviewed")}` +
				theme.fg(
					"dim",
					` ${counts.total ?? 0} finding(s), verdict: ${review?.verdict ?? "unknown"}${scoreText}`,
				);
			return new Text(
				progress ? `${theme.fg("dim", progress)}\n${summary}` : summary,
				0,
				0,
			);
		},
	});
}
