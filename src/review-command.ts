import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { getChangedFiles, getFileDiff } from "./git-diff.js";
import { buildReviewPrompts, buildSynthesisPrompt } from "./prompt-builder.js";
import { callLLM } from "./llm.js";
import { saveReview, formatReviewForDisplay } from "./persist.js";
import { loadConfig } from "./config.js";
import type { ReviewLens, ReviewOptions, ChangedFile, Finding, SynthesisResult, Severity } from "./types.js";

export const COMMAND_NAME = "drykiss";
export const KISS_COMMAND_NAME = "drykiss-kiss";
export const DRY_COMMAND_NAME = "drykiss-dry";

const MAX_FILES = 12;

export interface ParsedArgs extends ReviewOptions {
  readonly model?: string;
}

export function parseArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const files: string[] = [];
  let ref = "HEAD";
  let staged = false;
  let model: string | undefined;

  for (const token of tokens) {
    if (token === "--staged") {
      staged = true;
    } else if (token.startsWith("--ref=")) {
      ref = token.slice("--ref=".length);
    } else if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
    } else {
      files.push(token);
    }
  }

  return { files, ref, staged, model };
}

async function gatherDiffs(
  pi: ExtensionAPI,
  cwd: string,
  files: ChangedFile[],
  options: ReviewOptions,
): Promise<Map<string, string>> {
  const diffs = new Map<string, string>();
  for (const file of files) {
    try {
      const diff = await getFileDiff(pi, cwd, file.path, options);
      diffs.set(file.path, diff);
    } catch {
      diffs.set(file.path, "(diff unavailable)");
    }
  }
  return diffs;
}

function parseFindingsJson(raw: string, lens: ReviewLens): Finding[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : raw;
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((f: any) => ({
      file: String(f.file ?? "unknown"),
      line: typeof f.line === "number" ? f.line : undefined,
      severity: String(f.severity ?? "medium") as Severity,
      category: String(f.category ?? ""),
      summary: String(f.summary ?? ""),
      detail: String(f.detail ?? f.summary ?? ""),
      suggestion: String(f.suggestion ?? ""),
      lens,
    }));
  } catch {
    return [];
  }
}

function parseSynthesisJson(raw: string): SynthesisResult | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : raw;
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) return null;

    const findings = Array.isArray(parsed.findings)
      ? (parsed.findings as any[]).map((f: any) => ({
          file: String(f.file ?? "unknown"),
          line: typeof f.line === "number" ? f.line : undefined,
          severity: String(f.severity ?? "medium") as Severity,
          category: String(f.category ?? ""),
          summary: String(f.summary ?? ""),
          detail: String(f.detail ?? f.summary ?? ""),
          suggestion: String(f.suggestion ?? ""),
          confidence: String(f.confidence ?? "likely") as "confirmed" | "likely" | "suspect",
        }))
      : [];

    return {
      findings,
      summary: String(parsed.summary ?? ""),
      verdict: String(parsed.verdict ?? "Request changes") as SynthesisResult["verdict"],
      criticalCount: findings.filter((f) => f.severity === "critical").length,
      highCount: findings.filter((f) => f.severity === "high").length,
      mediumCount: findings.filter((f) => f.severity === "medium").length,
      lowCount: findings.filter((f) => f.severity === "low").length,
      nitCount: findings.filter((f) => f.severity === "nit").length,
    };
  } catch {
    return null;
  }
}

async function runLensReview(
  ctx: ExtensionContext,
  cwd: string,
  files: ChangedFile[],
  diffs: Map<string, string>,
  lens: ReviewLens,
  modelHint?: string,
): Promise<{ lens: ReviewLens; findings: Finding[]; rawOutput: string; modelName: string }> {
  const prompts = await buildReviewPrompts(files, diffs, lens);
  const prompt = prompts[0];
  if (!prompt) return { lens, findings: [], rawOutput: "", modelName: "none" };

  ctx.ui.notify(`[DRYKISS] Running ${lens} review...`, "info");

  const { text: rawOutput, model } = await callLLM(
    ctx,
    cwd,
    prompt.systemPrompt,
    prompt.userPrompt,
    { temperature: 0.2, maxTokens: 4000, signal: ctx.signal },
    modelHint ? undefined : lens,
  );

  const findings = parseFindingsJson(rawOutput, lens);
  return { lens, findings, rawOutput, modelName: model.name };
}

async function runSynthesis(
  ctx: ExtensionContext,
  cwd: string,
  lensReviews: Array<{ lens: ReviewLens; rawOutput: string }>,
  modelHint?: string,
): Promise<SynthesisResult> {
  const { systemPrompt, userPrompt } = buildSynthesisPrompt(lensReviews);

  ctx.ui.notify(`[DRYKISS] Synthesizing findings...`, "info");

  const { text: rawOutput } = await callLLM(
    ctx,
    cwd,
    systemPrompt,
    userPrompt,
    { temperature: 0.2, maxTokens: 4000, signal: ctx.signal },
    modelHint ? undefined : "synthesis",
  );

  const result = parseSynthesisJson(rawOutput);
  if (result) return result;

  return {
    findings: [],
    summary: "Synthesis returned non-JSON output. Raw response available in logs.",
    verdict: "Request changes",
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    nitCount: 0,
  };
}

export async function handleDrykissCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const options = parseArgs(args);
  const files = await getChangedFiles(pi, ctx.cwd, options);

  if (files.length === 0) {
    ctx.ui.notify("No changed files found. Specify file paths or make some changes first.", "info");
    return;
  }

  if (files.length > MAX_FILES) {
    ctx.ui.notify(
      `Too many changed files (${files.length}). DRYKISS reviews max ${MAX_FILES} files at a time.`,
      "warning",
    );
    return;
  }

  const diffs = await gatherDiffs(pi, ctx.cwd, files, options);
  const fileList = files.map((f) => f.path).join(", ");
  const config = await loadConfig(ctx.cwd);

  // Confirmation (respect config)
  if (config.confirmBeforeRun !== false) {
    const ok = await ctx.ui.confirm(
      "DRYKISS Review",
      `Review ${files.length} file(s) with 3 parallel lens reviews + synthesis.\n\nFiles: ${fileList}\n\nProceed?`,
    );
    if (!ok) {
      ctx.ui.notify("Review cancelled.", "info");
      return;
    }
  }

  try {
    const lenses: ReviewLens[] = ["simplicity", "deduplication", "clarity"];
    const lensReviews = await Promise.all(
      lenses.map((lens) => runLensReview(ctx, ctx.cwd, files, diffs, lens, options.model)),
    );

    const synthesis = await runSynthesis(
      ctx,
      ctx.cwd,
      lensReviews.map((r) => ({ lens: r.lens, rawOutput: r.rawOutput })),
      options.model,
    );

    const persistPath = await saveReview(
      ctx.cwd,
      files.map((f) => f.path),
      synthesis,
    );

    const report = formatReviewForDisplay({
      timestamp: new Date().toISOString(),
      files: files.map((f) => f.path),
      ...synthesis,
    });

    ctx.ui.notify(report, synthesis.criticalCount > 0 ? "error" : synthesis.highCount > 0 ? "warning" : "info");
    ctx.ui.notify(`Review persisted to: ${persistPath}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`DRYKISS review failed: ${err.message}`, "error");
  }
}

export async function handleKissCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const options = parseArgs(args);
  const files = await getChangedFiles(pi, ctx.cwd, options);

  if (files.length === 0) {
    ctx.ui.notify("No changed files found.", "info");
    return;
  }

  const diffs = await gatherDiffs(pi, ctx.cwd, files, options);

  try {
    const review = await runLensReview(ctx, ctx.cwd, files, diffs, "simplicity", options.model);
    const display = review.findings
      .map((f) => `[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? ""} — ${f.category}: ${f.summary}`)
      .join("\n") || "No simplicity concerns found.";
    ctx.ui.notify(`## KISS Review (${review.modelName})\n\n${display}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`KISS review failed: ${err.message}`, "error");
  }
}

export async function handleDryCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const options = parseArgs(args);
  const files = await getChangedFiles(pi, ctx.cwd, options);

  if (files.length === 0) {
    ctx.ui.notify("No changed files found.", "info");
    return;
  }

  const diffs = await gatherDiffs(pi, ctx.cwd, files, options);

  try {
    const review = await runLensReview(ctx, ctx.cwd, files, diffs, "deduplication", options.model);
    const display = review.findings
      .map((f) => `[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? ""} — ${f.category}: ${f.summary}`)
      .join("\n") || "No duplication concerns found.";
    ctx.ui.notify(`## DRY Review (${review.modelName})\n\n${display}`, "info");
  } catch (err: any) {
    ctx.ui.notify(`DRY review failed: ${err.message}`, "error");
  }
}

// ── Tool parameter schema ─────────────────────────────────

export const DrykissReviewParams = Type.Object({
  lens: StringEnum(["simplicity", "deduplication", "clarity"] as const, {
    description: "Which review lens to apply",
  }),
  files: Type.Array(Type.String(), {
    description: "File paths to review (relative to cwd)",
  }),
  model: Type.Optional(
    Type.String({
      description: "Model hint, e.g. 'haiku', 'sonnet', 'anthropic/claude-sonnet-4-5'",
    }),
  ),
});

export async function executeDrykissReviewTool(
  params: {
    lens: "simplicity" | "deduplication" | "clarity";
    files: string[];
    model?: string;
  },
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: { findings: Finding[] } }> {
  const options: ReviewOptions = {
    files: params.files,
    ref: "HEAD",
    staged: false,
  };

  const changedFiles = await getChangedFiles(pi, ctx.cwd, options);
  const filesToReview = changedFiles.length > 0 ? changedFiles : params.files.map((p) => ({
    path: p,
    status: "modified" as const,
    language: null,
  }));

  const diffs = await gatherDiffs(pi, ctx.cwd, filesToReview, options);
  const review = await runLensReview(ctx, ctx.cwd, filesToReview, diffs, params.lens, params.model);

  return {
    content: [{ type: "text", text: JSON.stringify(review.findings, null, 2) }],
    details: { findings: review.findings },
  };
}
