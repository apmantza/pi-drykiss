import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createEditTracker } from "./edit-tracker.js";
import { handleBeforeAgentStart } from "./auto-injector.js";
import {
  handleDrykissCommand,
  handleKissCommand,
  handleDryCommand,
  handleResilienceCommand,
  handleArchCommand,
  executeDrykissReviewTool,
  DrykissReviewParams,
  COMMAND_NAME,
  KISS_COMMAND_NAME,
  DRY_COMMAND_NAME,
  RESILIENCE_COMMAND_NAME,
  ARCH_COMMAND_NAME,
} from "./review-command.js";
import { handleConfigCommand } from "./config-command.js";
import { listReviews, formatReviewForDisplay } from "./persist.js";

export default function (pi: ExtensionAPI): void {
  const tracker = createEditTracker();

  // ── Track file edits across turns ──────────────────────
  pi.on("tool_execution_end", (event, _ctx) => {
    try {
      const { toolName, result } = event as {
        type: "tool_execution_end";
        toolName: string;
        result: unknown;
      };
      tracker.trackEdit(toolName, result);
    } catch (err) {
      console.error("[pi-drykiss] tool_execution_end error:", err);
    }
  });

  pi.on("turn_end", (event, _ctx) => {
    try {
      const { turnIndex } = event as { type: "turn_end"; turnIndex: number };
      tracker.onTurnEnd(turnIndex);
    } catch (err) {
      console.error("[pi-drykiss] turn_end error:", err);
    }
  });

  // ── Auto-inject KISS/DRY checklist before next turn ────
  pi.on("before_agent_start", (event, _ctx) => {
    try {
      const lastEdits = tracker.getLastTurnEdits();
      if (!lastEdits || lastEdits.files.length === 0) return;
      const result = handleBeforeAgentStart(
        event as { type: "before_agent_start"; prompt: string; systemPrompt: string },
        lastEdits,
      );
      tracker.clearLastTurnEdits();
      return result;
    } catch (err) {
      console.error("[pi-drykiss] before_agent_start error:", err);
    }
  });

  // ── /drykiss — Full multi-lens KISS/DRY review ─────────
  pi.registerCommand(COMMAND_NAME, {
    description:
      "Run a full KISS/DRY review on changed files using 5 parallel lens reviews + synthesis. Supports --model=hint. Configure defaults with /drykiss-config.",
    handler: (args: string, ctx: ExtensionCommandContext) =>
      handleDrykissCommand(args, ctx, pi),
  });

  // ── /drykiss-kiss — Focused simplicity review ──────────
  pi.registerCommand(KISS_COMMAND_NAME, {
    description:
      "Review changed files through the KISS lens. Supports --model=hint. Configure defaults with /drykiss-config.",
    handler: (args: string, ctx: ExtensionCommandContext) =>
      handleKissCommand(args, ctx, pi),
  });

  // ── /drykiss-dry — Focused duplication review ──────────
  pi.registerCommand(DRY_COMMAND_NAME, {
    description:
      "Review changed files through the DRY lens. Supports --model=hint. Configure defaults with /drykiss-config.",
    handler: (args: string, ctx: ExtensionCommandContext) =>
      handleDryCommand(args, ctx, pi),
  });

  // ── /drykiss-resilience — Error handling review ────────
  pi.registerCommand(RESILIENCE_COMMAND_NAME, {
    description:
      "Review changed files through the resilience lens (error handling, silent failures). Supports --model=hint.",
    handler: (args: string, ctx: ExtensionCommandContext) =>
      handleResilienceCommand(args, ctx, pi),
  });

  // ── /drykiss-arch — Architecture review ────────────────
  pi.registerCommand(ARCH_COMMAND_NAME, {
    description:
      "Review changed files through the architecture lens (SOLID, type design, dependencies). Supports --model=hint.",
    handler: (args: string, ctx: ExtensionCommandContext) =>
      handleArchCommand(args, ctx, pi),
  });

  // ── /drykiss-config — Configure defaults and models ────
  pi.registerCommand("drykiss-config", {
    description:
      "Configure DRYKISS defaults: set models per lens, toggle interactive mode, disable confirmations. Run without args to see current config.",
    handler: (args: string, ctx: ExtensionCommandContext) =>
      handleConfigCommand(args, ctx),
  });

  // ── /drykiss-history — Browse past reviews ─────────────
  pi.registerCommand("drykiss-history", {
    description:
      "Show past KISS/DRY review results persisted to .pi/drykiss/reviews/",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const reviews = await listReviews(ctx.cwd);
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
          r.criticalCount > 0
            ? "critical"
            : r.highCount > 0
              ? "high"
              : "ok";
        lines.push(
          `- **${r.timestamp}** — ${total} findings (${r.criticalCount} critical, ${r.highCount} high, ${r.mediumCount} medium) — verdict: ${r.verdict} ${badge === "critical" ? "(critical issues!)" : ""}`,
        );
      }

      if (reviews.length > 10) {
        lines.push(`\n... and ${reviews.length - 10} more`);
      }

      lines.push("\nRun `/drykiss-history` with a timestamp to view the full report.");
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

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeDrykissReviewTool(
        params as { lens: "simplicity" | "deduplication" | "clarity" | "resilience" | "architecture"; files: string[]; model?: string },
        ctx,
        pi,
      );
    },

    renderCall(args, theme) {
      const { Text } = require("@earendil-works/pi-tui");
      return new Text(
        theme.fg("toolTitle", theme.bold("drykiss_review ")) +
          theme.fg("accent", args.lens) +
          theme.fg("dim", ` ${args.files.length} file(s)${args.model ? " @" + args.model : ""}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const { Text } = require("@earendil-works/pi-tui");
      const findings = (result.details as any)?.findings ?? [];
      const critical = findings.filter((f: any) => f.severity === "critical").length;
      const high = findings.filter((f: any) => f.severity === "high").length;
      const icon = critical > 0 ? theme.fg("error", "✗") : high > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
      return new Text(
        `${icon} ${theme.fg("accent", findings.length + " finding(s)")}` +
          theme.fg("dim", ` (${critical} critical, ${high} high)`),
        0,
        0,
      );
    },
  });
}
