import type {
	ExtensionAPI,
	ExtensionCommandContext,
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
	handleJobsCommand,
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
} from "./review-command.js";
import { handleConfigCommand, handleSuppressCommand, handleListSuppressionsCommand, handleUnsuppressCommand } from "./config-command.js";
import { loadConfig } from "./config.js";
import { createEditTracker } from "./edit-tracker.js";
import { listReviews, formatReviewForDisplay } from "./persist.js";
import { buildAutoInjectBlock } from "./auto-inject.js";
import { ReviewManager } from "./review-manager.js";
import { ReviewProgressWidget } from "./review-widget.js";
import type { ReviewJob } from "./review-manager.js";

export default function (pi: ExtensionAPI): void {
	// ── Background review manager + live widget ────────────
	const widget = new ReviewProgressWidget();
	const manager = new ReviewManager(
		(_job) => widget.setJobs(manager.listJobs()),
		(job) => {
			widget.setJobs(manager.listJobs());
			sendReviewNotification(pi, job);
		},
	);
	manager.startCleanup();
	const editTracker = createEditTracker();
	const autoreviewEditedFiles = new Map<
		string,
		{ path: string; language: string | null }
	>();
	let autoreviewRunning = false;
	let lastAutoreviewSignature = "";
	let lastAutoreviewAt = 0;

	// Grab UI context from tool executions so widget renders even when no
	// command is active (matches pi-subagents pattern).
	pi.on("tool_execution_start", (_event: any, ctx: any) => {
		widget.attach(ctx.ui);
		widget.setJobs(manager.listJobs());
	});

	pi.on("agent_start", () => {
		autoreviewEditedFiles.clear();
	});

	pi.on("tool_execution_end", (event: any) => {
		if (event.isError) return;
		const edited = editTracker.trackEdit(
			event.toolName,
			event.result,
			event.args ?? event.input,
		);
		if (edited) autoreviewEditedFiles.set(edited.path, edited);
	});

	pi.on("turn_end", (event: any) => {
		editTracker.onTurnEnd(event.turnIndex ?? 0);
	});

	pi.on("before_agent_start", (event: any) => {
		const edits = editTracker.getLastTurnEdits();
		if (!edits) return undefined;
		editTracker.clearLastTurnEdits();
		return { systemPrompt: event.systemPrompt + buildAutoInjectBlock(edits) };
	});

	pi.on("agent_end", async (_event: any, ctx: any) => {
		if (autoreviewRunning || autoreviewEditedFiles.size === 0) return;

		try {
			const config = await loadConfig();
			const auto = config.autoreview;
			if (auto?.enabled !== true) return;

			const editedFiles = [...autoreviewEditedFiles.values()];
			const signature = [
				auto.mode ?? "local",
				auto.base ?? "",
				...editedFiles.map((f) => f.path).sort(),
			].join("|");
			const cooldownMs = auto.cooldownMs ?? 60_000;
			const now = Date.now();
			autoreviewEditedFiles.clear();
			if (
				cooldownMs > 0 &&
				signature === lastAutoreviewSignature &&
				now - lastAutoreviewAt < cooldownMs
			) {
				ctx.ui.notify(
					"Skipping duplicate DRYKISS autoreview within cooldown.",
					"info",
				);
				return;
			}
			if (auto.confirmBeforeRun !== false && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"DRYKISS Autoreview",
					`Run automatic DRYKISS review after edits?\n\nEdited files: ${editedFiles.map((f) => f.path).join(", ")}`,
				);
				if (!ok) return;
			}

			autoreviewRunning = true;
			lastAutoreviewSignature = signature;
			lastAutoreviewAt = now;
			const result = await executeDrykissAutoreviewTool(
				{
					mode: auto.mode ?? "local",
					files:
						auto.mode === "files" ? editedFiles.map((f) => f.path) : undefined,
					base: auto.base,
					lenses: auto.lenses,
					model: auto.model,
					contextMode: auto.contextMode,
					maxFiles: auto.maxFiles,
				},
				ctx,
				pi,
				manager,
				undefined,
				(update) =>
					ctx.ui.notify(
						update.content[0]?.text ?? "Running DRYKISS autoreview...",
						"info",
					),
			);
			const review = result.details.result;
			pi.sendMessage(
				{
					customType: "drykiss-autoreview-complete",
					content: result.content[0]?.text ?? "DRYKISS autoreview completed.",
					display: true,
					details: review,
				},
				{ deliverAs: "followUp", triggerTurn: !review.clean },
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`DRYKISS autoreview failed: ${msg}`, "error");
		} finally {
			autoreviewRunning = false;
		}
	});

	// Also grab UI context on session start so commands can show the widget
	pi.on("session_start", (_event: any, ctx: any) => {
		widget.attach(ctx.ui);
	});

	// ── Custom notification renderer for completed reviews ─
	pi.registerMessageRenderer<ReviewJob>(
		"drykiss-review-complete",
		(message: any, { expanded }: { expanded: boolean }, theme: any) => {
			const job = message.details;
			if (!job) return undefined;

			const s = job.synthesisResult;
			const hasError =
				job.overallStatus === "error" ||
				job.lenses.some(
					(l: string) => (job.states as any)[l]?.status === "error",
				);
			const hasCritical = s && s.criticalCount > 0;
			const hasHigh = s && s.highCount > 0;

			const icon = hasCritical
				? theme.fg("error", "✗")
				: hasError
					? theme.fg("error", "✗")
					: hasHigh
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");

			const statusText =
				job.overallStatus === "error" ? "completed with errors" : "completed";

			let line = `${icon} ${theme.bold(`DRYKISS Review`)} ${theme.fg("dim", statusText)}`;

			// Stats line
			const parts: string[] = [];
			if (s) {
				parts.push(`${s.findings.length} findings`);
				if (s.criticalCount > 0) parts.push(`${s.criticalCount} critical`);
				if (s.highCount > 0) parts.push(`${s.highCount} high`);
			}
			if (job.completedAt) {
				parts.push(`${((job.completedAt - job.startedAt) / 1000).toFixed(1)}s`);
			}
			if (parts.length) {
				line +=
					"\n  " +
					parts
						.map((p) => theme.fg("dim", p))
						.join(` ${theme.fg("dim", "·")} `);
			}

			// Verdict
			if (s?.verdict) {
				line += `\n  ${theme.fg("accent", `Verdict: ${s.verdict}`)}`;
			}

			// Result preview (collapsed) or full report (expanded)
			if (expanded && s) {
				const reportLines = formatReviewForDisplay({
					timestamp: new Date(job.startedAt).toISOString(),
					files: job.files,
					findings: s.findings,
					summary: s.summary,
					verdict: s.verdict,
					criticalCount: s.criticalCount,
					highCount: s.highCount,
					mediumCount: s.mediumCount,
					lowCount: s.lowCount,
					nitCount: s.nitCount,
				}).split("\n");
				for (const rl of reportLines.slice(0, 40)) {
					line += "\n" + theme.fg("dim", `  ${rl}`);
				}
				if (reportLines.length > 40) {
					line +=
						"\n" +
						theme.fg("dim", `  ... (${reportLines.length - 40} more lines)`);
				}
			} else if (s?.summary) {
				line += "\n  " + theme.fg("dim", `⎿  ${s.summary.slice(0, 80)}`);
			}

			return new Text(line, 0, 0);
		},
	);

	function sendReviewNotification(piRef: ExtensionAPI, job: ReviewJob) {
		const s = job.synthesisResult;
		const report = s
			? formatReviewForDisplay({
					timestamp: new Date(job.startedAt).toISOString(),
					files: job.files,
					findings: s.findings,
					summary: s.summary,
					verdict: s.verdict,
					criticalCount: s.criticalCount,
					highCount: s.highCount,
					mediumCount: s.mediumCount,
					lowCount: s.lowCount,
					nitCount: s.nitCount,
				})
			: "Review completed but synthesis produced no output.";

		// Strip session objects (contain non-cloneable async handlers) before sending
		// Convert Map to plain object for serialization (structured clone fails on Maps)
		const serializableJob = {
			...job,
			states: Object.fromEntries(
				[...job.states.entries()].map(([lens, state]) => [
					lens,
					{ ...state, session: undefined },
				]),
			),
			synthesisSession: undefined,
		};

		piRef.sendMessage<ReviewJob>(
			{
				customType: "drykiss-review-complete",
				content: report,
				display: true,
				details: serializableJob as unknown as ReviewJob,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	// ── /drykiss — Full multi-lens KISS/DRY review ─────────
	pi.registerCommand(COMMAND_NAME, {
		description:
			"Run a full KISS/DRY review on changed files using 7 parallel lens reviews + synthesis. Supports --all, --staged, --ref=branch, --model=hint. Configure defaults with /drykiss-config.",
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
			const reviews = await listReviews();
			if (reviews.length === 0) {
				ctx.ui.notify("No past reviews found.", "info");
				return;
			}

			const lines: string[] = [`## Past Reviews (${reviews.length} total)`, ""];
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
		},
	});

	// ── drykiss_autoreview tool — Programmatic multi-lens review ─────
	pi.registerTool({
		name: "drykiss_autoreview",
		label: "DRYKISS Autoreview",
		description:
			"Run a blocking multi-lens DRYKISS review over a git/PR/codebase target. Supports local, staged, branch, commit, PR, full, and explicit-file scopes. Returns a stable structured ReviewResult.",
		promptSnippet:
			"Run a multi-lens DRYKISS autoreview over a git/PR/codebase target",
		promptGuidelines: [
			"Use drykiss_autoreview for closeout code reviews, git diff reviews, PR reviews, full-codebase scans, or when the user asks for autoreview.",
			"Prefer mode 'local' for uncommitted changes, 'staged' for staged changes, 'branch' with base for branch reviews, 'commit' with commit for single commits, 'pr' with pr for GitHub PRs, and 'files' with files for explicit paths.",
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
			const mode =
				args.mode ?? (args.pr ? "pr" : args.files ? "files" : "local");
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
			const review = (result.details as any)?.result;
			const clean = review?.clean === true;
			const counts = review?.counts ?? {};
			const icon = clean ? theme.fg("success", "✓") : theme.fg("warning", "◐");
			return new Text(
				`${icon} ${theme.fg("accent", clean ? "clean" : "reviewed")}` +
					theme.fg(
						"dim",
						` ${counts.total ?? 0} finding(s), verdict: ${review?.verdict ?? "unknown"}`,
					),
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
			"Review code changes through a specific DRYKISS lens. Returns structured JSON findings. Use for focused reviews on specific files.",
		promptSnippet: "Run a focused DRYKISS lens review on code changes",
		promptGuidelines: [
			"Use drykiss_review when the user asks for a focused code quality, simplicity, duplication, resilience, architecture, tests, or security review on specific files.",
			"Pass one lens ('simplicity', 'deduplication', 'clarity', 'resilience', 'architecture', 'tests', or 'security') and the file paths to review.",
			"Optionally pass a model hint like 'haiku' for faster/cheaper reviews or 'sonnet' for deeper analysis.",
		],
		parameters: DrykissReviewParams,

		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: any,
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
			const findings = (result.details as any)?.findings ?? [];
			const critical = findings.filter(
				(f: any) => f.severity === "critical",
			).length;
			const high = findings.filter((f: any) => f.severity === "high").length;
			const icon =
				critical > 0
					? theme.fg("error", "✗")
					: high > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
			return new Text(
				`${icon} ${theme.fg("accent", findings.length + " finding(s)")}` +
					theme.fg("dim", ` (${critical} critical, ${high} high)`),
				0,
				0,
			);
		},
	});
}
