import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	handleDrykissCommand,
	handleKissCommand,
	handleDryCommand,
	handleResilienceCommand,
	handleArchCommand,
	handleTestsCommand,
	handleSecurityCommand,
	handleDocsCommand,
	handleJobsCommand,
	handleEndReviewCommand,
	executeDrykissReviewTool,
	executeDrykissAutoreviewTool,
	DrykissReviewParams,
	DrykissAutoreviewParams,
	COMMAND_NAME,
	KISS_COMMAND_NAME,
	DRY_COMMAND_NAME,
	RESILIENCE_COMMAND_NAME,
	ARCH_COMMAND_NAME,
	TESTS_COMMAND_NAME,
	SECURITY_COMMAND_NAME,
	DOCS_COMMAND_NAME,
} from "./review-command.js";
import { applyReviewState, setReviewInProgress } from "./review-session.js";
import {
	handleConfigCommand,
	handleSuppressCommand,
	handleListSuppressionsCommand,
	handleUnsuppressCommand,
} from "./config-command.js";
import { createEditTracker } from "./edit-tracker.js";
import { listReviews } from "./persist.js";
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
	// command is active (matches pi-subagents pattern).
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

	// Also grab UI context on session changes so commands can show widgets
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

	// ── /drykiss — Full multi-lens KISS/DRY review ─────────
	pi.registerCommand(COMMAND_NAME, {
		description:
			"Run a full KISS/DRY review on changed files using 7 parallel lens reviews + synthesis. Supports --all, --staged, --ref=branch, --model=hint, --branch. Configure defaults with /drykiss-config.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleDrykissCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-kiss — Focused simplicity review ──────────
	pi.registerCommand(KISS_COMMAND_NAME, {
		description:
			"Review changed files through the KISS lens. Supports --model=hint. Configure defaults with /drykiss-config.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleKissCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-dry — Focused duplication review ──────────
	pi.registerCommand(DRY_COMMAND_NAME, {
		description:
			"Review changed files through the DRY lens. Supports --model=hint. Configure defaults with /drykiss-config.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleDryCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-resilience — Error handling review ────────
	pi.registerCommand(RESILIENCE_COMMAND_NAME, {
		description:
			"Review changed files through the resilience lens (error handling, silent failures). Supports --model=hint.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleResilienceCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-arch — Architecture review ────────────────
	pi.registerCommand(ARCH_COMMAND_NAME, {
		description:
			"Review changed files through the architecture lens (SOLID, type design, dependencies). Supports --model=hint.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleArchCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-tests — Test coverage review ──────────────
	pi.registerCommand(TESTS_COMMAND_NAME, {
		description:
			"Review changed files through the tests lens (missing coverage, edge cases, test quality). Supports --model=hint.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleTestsCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-security — Security vulnerability scan ────
	pi.registerCommand(SECURITY_COMMAND_NAME, {
		description:
			"Quick security scan for vulnerabilities, credential exposure, and attack surface issues. Supports --model=hint.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleSecurityCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-docs — Documentation accuracy audit ───────
	// Catches drift between README/CHANGELOG/AGENTS.md and the
	// actual project state (commands, paths, symbols, claims).
	// Distinct from Clarity's comment-accuracy check, which only
	// looks at code-internal comments.
	pi.registerCommand(DOCS_COMMAND_NAME, {
		description:
			"Review project documentation (README, CHANGELOG, AGENTS.md) for drift against current code, commands, and paths. Supports --model=hint.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleDocsCommand(args, ctx, pi, manager),
	});

	// ── /drykiss-config — Configure defaults and models ────
	pi.registerCommand("drykiss-config", {
		description:
			"Configure DRYKISS defaults: set models per lens, toggle interactive mode, disable confirmations. Run without args to see current config.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleConfigCommand(args, ctx),
	});

	// ── /drykiss-suppress — Suppress a finding pattern ─────
	pi.registerCommand("drykiss-suppress", {
		description:
			"Suppress findings matching a risk code and file pattern. Usage: /drykiss-suppress <riskCode> <pattern> <reason> [--expires=90d|YYYY-MM-DD]",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleSuppressCommand(args, ctx, ctx.cwd ?? ""),
	});

	// ── /drykiss-suppressions — List active suppressions ────
	pi.registerCommand("drykiss-suppressions", {
		description:
			"List all active suppressions for this project. Run /drykiss-unsuppress <id> to remove one.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleListSuppressionsCommand(args, ctx, ctx.cwd ?? ""),
	});

	// ── /drykiss-unsuppress — Remove a suppression ──────────
	pi.registerCommand("drykiss-unsuppress", {
		description:
			"Remove a suppression by its ID. Usage: /drykiss-unsuppress <suppression-id>",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleUnsuppressCommand(args, ctx, ctx.cwd ?? ""),
	});

	// ── /drykiss-end — Return from isolated review branch ───
	pi.registerCommand("drykiss-end", {
		description:
			"End an isolated DRYKISS review session created with /drykiss --branch and return to the original conversation position.",
		handler: (args: string, ctx: ExtensionCommandContext) =>
			handleEndReviewCommand(args, ctx, pi),
	});

	// ── /drykiss-jobs — Inspect running/completed reviews ──
	pi.registerCommand("drykiss-jobs", {
		description:
			"Browse running and completed DRYKISS reviews. Select one to view its full lens conversation.",
		handler: (_args: string, ctx: ExtensionCommandContext) =>
			handleJobsCommand(_args, ctx, manager),
	});

	// ── /drykiss-history — Browse past reviews ─────────────
	pi.registerCommand("drykiss-history", {
		description:
			"Show past KISS/DRY review results persisted to ~/.pi/drykiss/reviews/",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const reviews = await listReviews();
				if (reviews.length === 0) {
					ctx.ui.notify("No past reviews found.", "info");
					return;
				}

				const lines: string[] = [
					`## Past Reviews (${reviews.length} total)`,
					"",
				];
				for (const r of reviews.slice(0, 10)) {
					const total = r.findings.length;
					const badge =
						r.criticalCount > 0 ? "critical" : r.highCount > 0 ? "high" : "ok";
					lines.push(
						`- **${r.timestamp}** — ${total} findings (${r.criticalCount} critical, ${r.highCount} high, ${r.mediumCount} medium) — verdict: ${r.verdict} ${badge === "critical" ? "(critical issues!)" : ""}`,
					);
				}

				if (reviews.length > 10) {
					lines.push(`\n... and ${reviews.length - 10} more`);
				}

				lines.push(
					"\nRun `/drykiss-history` with a timestamp to view the full report.",
				);
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				ctx.ui.notify(
					`${LOG_PREFIX} Failed to load review history: ${toErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	// ── drykiss_autoreview tool — Programmatic multi-lens review ─────
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
			"Optional: pass `lenses` to run a subset (default is all). Pass `format: 'structured'` if you need the full markdown report; default 'compact' is one line per finding.",
			"Model selection, context mode, max files, validator, and deep mode are config-driven — not exposed here. Use /drykiss-config to change them.",
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
			return new Text(
				theme.fg("toolTitle", theme.bold("drykiss_autoreview ")) +
					theme.fg("accent", mode) +
					theme.fg("dim", target ? ` ${target}` : ""),
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
			// Surface the health score in the same one-liner so users
			// see the bottom line without expanding. Same color bands
			// as the message renderer / notification body / widget
			// summary — 80/50 thresholds so the rule is learned once.
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

	// ── drykiss_review tool — Programmatic lens review ─────
	pi.registerTool({
		name: "drykiss_review",
		label: "DRYKISS Review",
		description:
			"Review code changes through a specific DRYKISS lens. Returns structured JSON findings. Use for focused reviews on specific files. Model selection is config-driven.",
		promptSnippet: "Run a focused DRYKISS lens review on code changes",
		promptGuidelines: [
			"Use drykiss_review when the user asks for a focused code quality, simplicity, duplication, resilience, architecture, tests, or security review on specific files.",
			"Pass one lens ('simplicity', 'deduplication', 'clarity', 'resilience', 'architecture', 'tests', or 'security') and the file paths to review.",
			"Model selection is config-driven (per-lens overrides, autoroute). Use /drykiss-config to change models — the tool does not accept a model parameter.",
		],
		parameters: DrykissReviewParams,

		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: any,
			ctx: any,
		) {
			return executeDrykissReviewTool(
				params as {
					lens:
						| "simplicity"
						| "deduplication"
						| "clarity"
						| "resilience"
						| "architecture"
						| "tests"
						| "security";
					files: string[];
					model?: string;
				},
				ctx,
				pi,
				signal,
				onUpdate,
			);
		},

		renderCall(args: any, theme: any) {
			return new Text(
				theme.fg("toolTitle", theme.bold("drykiss_review ")) +
					theme.fg("accent", args.lens) +
					theme.fg(
						"dim",
						` ${args.files.length} file(s)${args.model ? " @" + args.model : ""}`,
					),
				0,
				0,
			);
		},

		renderResult(result: any, _options: any, theme: any) {
			const findings = result.details?.findings ?? [];
			const critical = findings.filter(
				(f: any) => f.severity === "critical",
			).length;
			const high = findings.filter((f: any) => f.severity === "high").length;
			let icon;
			if (critical > 0) {
				icon = theme.fg("error", "✗");
			} else if (high > 0) {
				icon = theme.fg("warning", "◐");
			} else {
				icon = theme.fg("success", "✓");
			}
			return new Text(
				`${icon} ${theme.fg("accent", findings.length + " finding(s)")}` +
					theme.fg("dim", ` (${critical} critical, ${high} high)`),
				0,
				0,
			);
		},
	});
}
