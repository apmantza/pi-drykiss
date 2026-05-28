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
	DrykissReviewParams,
	COMMAND_NAME,
	KISS_COMMAND_NAME,
	DRY_COMMAND_NAME,
	RESILIENCE_COMMAND_NAME,
	ARCH_COMMAND_NAME,
	TESTS_COMMAND_NAME,
	SECURITY_COMMAND_NAME,
} from "./review-command.js";
import { handleConfigCommand } from "./config-command.js";
import { listReviews, formatReviewForDisplay } from "./persist.js";
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

	// Grab UI context from tool executions so widget renders even when no
	// command is active (matches pi-subagents pattern).
	pi.on("tool_execution_start", (_event: any, ctx: any) => {
		widget.attach(ctx.ui);
		widget.setJobs(manager.listJobs());
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
			"Run a full KISS/DRY review on changed files using 6 parallel lens reviews + synthesis. Supports --all, --staged, --ref=branch, --model=hint. Configure defaults with /drykiss-config.",
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
			const reviews = await listReviews(ctx.cwd);
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

	// ── drykiss_review tool — Programmatic lens review ─────
	pi.registerTool({
		name: "drykiss_review",
		label: "DRYKISS Review",
		description:
			"Review code changes through a specific lens (simplicity, deduplication, or clarity). Returns structured JSON findings. Use when the user asks for a focused code review on specific files.",
		promptSnippet: "Run a KISS, DRY, or clarity lens review on code changes",
		promptGuidelines: [
			"Use drykiss_review when the user asks for a code quality review, simplicity audit, or duplication check.",
			"Pass the lens ('simplicity', 'deduplication', 'clarity') and file paths to review.",
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
