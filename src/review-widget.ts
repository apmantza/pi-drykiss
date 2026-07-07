import { truncateToWidth, hyperlink } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import type { ReviewJob } from "./review-manager.js";
import { LENS_DISPLAY_NAMES } from "./constants.js";
import { pathToFileLink } from "./persist.js";
import { stripAnsi } from "./content-utils.js";
import type { Finding, Severity } from "./types.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Format a millisecond duration as a compact elapsed-time string. */
function formatElapsed(ms: number): string {
	const safe = Math.max(0, ms);
	const totalSec = Math.floor(safe / 1000);
	if (totalSec < 60) {
		return `${(safe / 1000).toFixed(1)}s`;
	}
	const mins = Math.floor(totalSec / 60);
	const secs = totalSec % 60;
	if (mins < 60) {
		return `${mins}m ${secs.toString().padStart(2, "0")}s`;
	}
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return `${hours}h ${remMins.toString().padStart(2, "0")}m`;
}

/**
 * Render an OSC 8 hyperlink pointing at a lens's exported session
 * transcript, or an empty string if no log path is available.
 *
 * Falls back to plain text in terminals that don't support OSC 8 — the
 * escape sequences are ignored and the user sees the basename, which is
 * still copy-pasteable.
 */
function renderLogLink(logPath: string | undefined, theme: Theme): string {
	if (!logPath) return "";
	const name = basename(logPath);
	const url = pathToFileLink(logPath);
	// OSC 8 hyperlinks render with the terminal's default link styling
	// (typically colored + underlined) in supporting terminals. In others
	// the escape codes are stripped, leaving just the dim-colored basename
	// which is still copy-pasteable.
	const label = theme.fg("dim", name);
	return ` · ${hyperlink(label, url)}`;
}

/** Symbol per severity used by formatFinding. */
const SEVERITY_ICON: Record<Severity, string> = {
	critical: "🔴",
	high: "🟠",
	medium: "🟡",
	low: "🔵",
	nit: "⚪",
};

/** Short label for fixability in the rendered line. */
const FIXABILITY_LABEL: Record<NonNullable<Finding["fixability"]>, string> = {
	"quick-fix": "quick-fix (1-line)",
	guided: "guided (~10 lines)",
	manual: "manual (larger refactor)",
};

/**
 * A lens state with the two fields the widget cares about for the
 * "Models used" line. Loose shape so we can read it from both the
 * strongly-typed `Map<ReviewLens, LensState>` on `ReviewJob.states`
 * and the post-serialization `Record<string, unknown>` shape that
 * the message renderer receives (where the field types are erased).
 */
export interface ModelPairSource {
	readonly provider?: unknown;
	readonly modelName?: unknown;
}

/**
 * Collect distinct "provider/modelName" strings across a job's lens
 * states, skipping empty/whitespace-only entries. Single source of
 * truth for both the TUI widget and the completed-review
 * notification body — keep the two in sync by routing through here.
 *
 * Returns an array sorted alphabetically so the output is
 * deterministic regardless of lens iteration order.
 */
export function collectModelPairs(
	lensStates: Iterable<[string, ModelPairSource | undefined]>,
): string[] {
	const pairs = new Set<string>();
	for (const [, st] of lensStates) {
		if (!st) continue;
		const prov = typeof st.provider === "string" ? st.provider.trim() : "";
		const name = typeof st.modelName === "string" ? st.modelName.trim() : "";
		if (!prov && !name) continue;
		pairs.add(prov && name ? `${prov}/${name}` : prov || name);
	}
	return [...pairs].sort((a, b) => a.localeCompare(b));
}

/**
 * Pick a verdict string for display when synthesis.verdict may be
 * missing or non-string. Shared by the TUI widget completed summary
 * and the message renderer so the two surfaces never disagree on
 * "what verdict do we show for a job with no synthesis verdict?"
 *
 * Rules (in order):
 *   1. If synthesis.verdict is a non-empty string, return it.
 *   2. If the job errored, return "Review failed" — an
 *      infrastructure failure must not be conflated with a content
 *      verdict like "Request changes".
 *   3. Otherwise, return "Request changes" as a safe default that
 *      matches the fallback in createFallbackSynthesis.
 *
 * Uses || (not ??) so empty strings also fall through to the
 * fallback — an LLM that emits {"verdict": ""} should not produce
 * a blank "Verdict:" line in the TUI.
 */
export function pickVerdict(
	synthesisVerdict: unknown,
	hasError: boolean,
): string {
	if (typeof synthesisVerdict === "string" && synthesisVerdict.length > 0) {
		return synthesisVerdict;
	}
	return hasError ? "Review failed" : "Request changes";
}

type FindingTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
};

/**
 * Render a Finding as a multi-line human-readable string.
 *
 * Output shape:
 *   🔴 [KISS] Divergent Change — UserService.update_profile (src/user.ts:42)
 *      Symptom: ...detail...
 *      → Consequence: ...consequence...
 *      → Source: ...source...
 *      → Fix: quick-fix (1-line) — ...suggestion...
 *
 * Lines that have no data (e.g. legacy findings without consequence) are
 * omitted. Lens name is rendered from LENS_DISPLAY_NAMES when the finding
 * carries a `lens` field. The theme parameter allows the caller to inject
 * terminal colors; the default is no-color for tests.
 */
export function formatFinding(
	finding: Finding,
	theme: FindingTheme = defaultTheme,
): string {
	const lensName = finding.lens
		? (LENS_DISPLAY_NAMES[finding.lens] ?? finding.lens)
		: "Review";
	const icon = SEVERITY_ICON[finding.severity] ?? "⚪";
	const tag = theme.fg("accent", `[${lensName}]`);
	const category = theme.bold(finding.category);
	const source = stripAnsi(finding.source ?? "");
	const location = finding.line
		? ` (${finding.file}:${finding.line})`
		: ` (${finding.file})`;
	const heading = `${icon} ${tag} ${category} — ${source}${location}`;
	const suppressedTag = finding._suppressed
		? ` ${theme.fg("dim", "[suppressed]")}`
		: "";
	const previouslyRejectedTag = finding._previouslyRejected
		? ` ${theme.fg("dim", "[⟲ previously rejected]")}`
		: "";
	const validatorTag = finding._validatorVerdict
		? ` ${validatorTagStyle(finding._validatorVerdict, theme)}`
		: "";

	const lines: string[] = [
		`${heading}${suppressedTag}${previouslyRejectedTag}${validatorTag}`,
	];
	const indent = "   ";
	if (finding.detail) {
		lines.push(`${indent}Symptom: ${stripAnsi(finding.detail)}`);
	}
	if (finding.consequence) {
		lines.push(
			`${indent}${theme.fg("warning", "→ Consequence:")} ${stripAnsi(finding.consequence)}`,
		);
	}
	if (finding.source && finding.source !== finding.summary) {
		// already in heading; only repeat if it carries separate meaning
	}
	if (finding.suggestion) {
		if (finding.fixability) {
			const fixLabel = FIXABILITY_LABEL[finding.fixability];
			lines.push(
				`${indent}${theme.fg("success", "→ Fix:")} ${fixLabel} — ${stripAnsi(finding.suggestion)}`,
			);
		} else {
			lines.push(
				`${indent}${theme.fg("success", "→ Fix:")} ${stripAnsi(finding.suggestion)}`,
			);
		}
	}
	if (finding.riskCode) {
		const riskTag = theme.fg("dim", `[riskCode: ${finding.riskCode}]`);
		lines.push(`${indent}${riskTag}`);
	}
	if (finding._validatorJustification) {
		const validatorMsg = theme.fg(
			"dim",
			`Validator: ${stripAnsi(finding._validatorJustification)}`,
		);
		lines.push(`${indent}${validatorMsg}`);
	}
	return lines.join("\n");
}

/** Render a colored tag for a validator verdict. Distinct from suppression / rejection. */
function validatorTagStyle(
	verdict: NonNullable<Finding["_validatorVerdict"]>,
	theme: FindingTheme,
): string {
	switch (verdict) {
		case "real":
			return theme.fg("success", "[✓ validator: real]");
		case "false-positive":
			return theme.fg("warning", "[✗ validator: false-positive]");
		case "unverified":
		default:
			return theme.fg("dim", "[? validator: unverified]");
	}
}

const defaultTheme: FindingTheme = {
	fg: (_c, t) => t,
	bold: (t) => t,
	dim: (t) => t,
};

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

export class ReviewProgressWidget {
	private uiCtx: any;
	private readonly widgetKey = "drykiss-review";
	private widgetRegistered = false;
	private tui: any;
	private timer: ReturnType<typeof setInterval> | undefined;
	private frame = 0;
	private jobs: ReviewJob[] = [];

	attach(uiCtx: any) {
		if (!uiCtx?.setWidget) return;
		this.uiCtx = uiCtx;
		this.ensureTimer();
		this.update();
	}

	setJobs(jobs: ReviewJob[]) {
		this.jobs = jobs;
		this.update();
	}

	private ensureTimer() {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame++;
			this.update();
		}, 80);
	}

	/**
	 * Stop the render timer when no jobs need live updates. Completed
	 * jobs render a static summary, so 12 ticks/second of `frame++` +
	 * `update()` is pure CPU/battery waste. The next `setJobs()` (if
	 * any) restarts the timer via `ensureTimer()`.
	 */
	private stopTimer() {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private renderWidget(_tui: any, theme: Theme): string[] {
		const w = _tui.terminal?.columns ?? 80;
		const truncate = (line: string) => truncateToWidth(line, w);
		const frame = SPINNER[this.frame % SPINNER.length];
		const lines: string[] = [];

		for (const job of this.jobs) {
			const isLive =
				job.overallStatus === "running" || job.overallStatus === "queued";
			if (!isLive) {
				if (job.overallStatus === "done" || job.overallStatus === "error") {
					lines.push(...this.renderCompletedSummary(job, theme, truncate));
				}
				continue;
			}

			// Running / queued: single progress line with spinner.
			const icon =
				job.overallStatus === "running"
					? theme.fg("accent", frame)
					: theme.fg("dim", "○");
			const heading = theme.fg("accent", theme.bold("DRYKISS Review"));
			const fileCount = theme.fg("dim", `${job.files.length} file(s)`);

			let activeCount = 0;
			let doneCount = 0;
			for (const lens of job.lenses) {
				const s = job.states.get(lens)!;
				if (s.status === "running") activeCount++;
				else if (s.status === "done" || s.status === "error") doneCount++;
			}
			const totalLenses = job.lenses.length;
			const elapsed =
				job.overallStatus === "running" && job.startedAt
					? ` · running ${formatElapsed(Date.now() - job.startedAt)}`
					: "";
			const progress = theme.fg(
				"dim",
				`${doneCount}/${totalLenses} complete` +
					(activeCount > 0 ? ` · ${activeCount} active` : ""),
			);
			lines.push(
				truncate(`${icon} ${heading} · ${fileCount} · ${progress}${elapsed}`),
			);
		}

		return lines;
	}

	/**
	 * Render a compact post-completion summary for a job that has
	 * finished. Surfaces the health score, verdict, and per-lens
	 * model breakdown so the user sees the bottom line immediately,
	 * without waiting for the follow-up notification message.
	 *
	 * The completed summary is intentionally short (4 lines max) so it
	 * doesn't compete with the running-widget for vertical space —
	 * once the user dismisses or scrolls past it, the widget hides
	 * itself via the existing `hasAnything` check in `update()`.
	 */
	private renderCompletedSummary(
		job: ReviewJob,
		theme: Theme,
		truncate: (line: string) => string,
	): string[] {
		const out: string[] = [];
		const s = job.synthesisResult;
		const hasError = job.overallStatus === "error";

		// Line 1: heading with verdict + score + elapsed.
		const icon = hasError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const verdict = pickVerdict(s?.verdict, hasError);
		const healthScore = s?.healthScore;
		const elapsed =
			job.completedAt && job.startedAt
				? formatElapsed(job.completedAt - job.startedAt)
				: "";

		const headingParts: string[] = [];
		headingParts.push(
			`${icon} ${theme.bold("DRYKISS Review")} · ${theme.fg("accent", `Verdict: ${verdict}`)}`,
		);
		if (typeof healthScore === "number") {
			const scoreColor =
				healthScore >= 80 ? "success" : healthScore >= 50 ? "warning" : "error";
			headingParts.push(theme.fg(scoreColor, `score ${healthScore}/100`));
		}
		if (elapsed) headingParts.push(elapsed);
		out.push(truncate(headingParts.join(` ${theme.fg("dim", "·")} `)));

		// Lines 2+: one line per lens with status + duration + findings + model.
		for (const lens of job.lenses) {
			const st = job.states.get(lens);
			if (!st) continue;
			const displayName = LENS_DISPLAY_NAMES[lens] ?? lens;
			const lensIcon =
				st.status === "done"
					? theme.fg("success", "✓")
					: st.status === "error"
						? theme.fg("error", "✗")
						: theme.fg("dim", "○");
			const dur =
				st.durationMs > 0 ? `${(st.durationMs / 1000).toFixed(1)}s` : "-";
			const findings =
				st.findingsCount > 0 ? `${st.findingsCount} findings` : "0 findings";
			const errorTag =
				st.status === "error" && st.errorMessage
					? theme.fg("error", ` · ${st.errorMessage.slice(0, 30)}`)
					: "";
			const prov = st.provider?.trim() ?? "";
			const modelName = st.modelName?.trim() ?? "";
			const modelLabel = prov ? `${prov}/${modelName}` : modelName;
			const model = modelLabel ? theme.fg("dim", `@ ${modelLabel}`) : "";
			const linkSegment =
				st.status === "done" || st.status === "error"
					? renderLogLink(st.logPath, theme)
					: "";
			out.push(
				truncate(
					`  ${lensIcon} ${theme.bold(displayName)} · ${dur} · ${findings}${model ? ` · ${model}` : ""}${errorTag}${linkSegment}`,
				),
			);
		}

		// Last line: findings split by severity. Use the synthesis
		// severity counts (not the deduplicated findings array length)
		// so the breakdown is visible even when the persisted findings
		// list is empty but the lens reported counts.
		const totalFindings =
			(s?.criticalCount ?? 0) +
			(s?.highCount ?? 0) +
			(s?.mediumCount ?? 0) +
			(s?.lowCount ?? 0) +
			(s?.nitCount ?? 0);
		if (totalFindings > 0) {
			const parts: string[] = [`${totalFindings} findings`];
			if (s?.criticalCount && s.criticalCount > 0)
				parts.push(`${s.criticalCount} critical`);
			if (s?.highCount && s.highCount > 0) parts.push(`${s.highCount} high`);
			if (s?.mediumCount && s.mediumCount > 0)
				parts.push(`${s.mediumCount} medium`);
			if (s?.lowCount && s.lowCount > 0) parts.push(`${s.lowCount} low`);
			if (s?.nitCount && s.nitCount > 0) parts.push(`${s.nitCount} nit`);
			out.push(
				truncate(
					`  ${theme.fg("dim", parts.join(` ${theme.fg("dim", "·")} `))}`,
				),
			);
		}

		return out;
	}

	private update() {
		if (!this.uiCtx?.setWidget) return;

		// Keep the widget alive if there's anything to show: live
		// jobs, or completed jobs whose summary hasn't been read
		// yet. Without completed jobs the user would lose the
		// health-score summary the instant synthesis finishes.
		// The cleanup job in ReviewManager removes old completed
		// jobs after 10 minutes, which is when this widget
		// disposes naturally.
		const hasAnything = this.jobs.length > 0;
		// Live timer ticks are only useful while at least one job
		// is running or queued (spinner + elapsed counter). Stop
		// the 12Hz tick when only completed jobs remain.
		const hasLive = this.jobs.some(
			(j) => j.overallStatus === "running" || j.overallStatus === "queued",
		);
		if (hasLive) {
			this.ensureTimer();
		} else {
			this.stopTimer();
		}

		if (!hasAnything) {
			this.dispose();
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				this.widgetKey,
				(tui: any, theme: Theme) => {
					this.tui = tui;
					return {
						render: () => this.renderWidget(tui, theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender?.();
		}
	}

	dispose() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.uiCtx?.setWidget) {
			this.uiCtx.setWidget(this.widgetKey, undefined);
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.jobs = [];
	}
}
