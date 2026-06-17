import { truncateToWidth, hyperlink } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import type { ReviewJob, LensStatus } from "./review-manager.js";
import { LENS_DISPLAY_NAMES } from "./constants.js";
import { pathToFileLink } from "./persist.js";
import { stripAnsi } from "./content-utils.js";
import type { Finding, Severity } from "./types.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Format a millisecond duration as a compact elapsed-time string. */
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
		lines.push(
			`${indent}${theme.fg("dim", `[riskCode: ${finding.riskCode}]`)}`,
		);
	}
	if (finding._validatorJustification) {
		lines.push(
			`${indent}${theme.fg("dim", `Validator: ${stripAnsi(finding._validatorJustification)}`)}`,
		);
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
	private widgetKey = "drykiss-review";
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
		if (!this.timer) {
			this.timer = setInterval(() => {
				this.frame++;
				this.update();
			}, 80);
		}
	}

	private renderWidget(_tui: any, theme: Theme): string[] {
		const w = _tui.terminal?.columns ?? 80;
		const truncate = (line: string) => truncateToWidth(line, w);
		const frame = SPINNER[this.frame % SPINNER.length];
		const lines: string[] = [];

		for (const job of this.jobs) {
			if (job.overallStatus !== "running" && job.overallStatus !== "queued") {
				continue;
			}

			const heading =
				job.overallStatus === "running"
					? theme.fg("accent", theme.bold("● DRYKISS Review"))
					: theme.fg("dim", theme.bold("○ DRYKISS Review (queued)"));
			const fileCount = theme.fg("dim", `· ${job.files.length} file(s)`);
			lines.push(truncate(`${heading} ${fileCount}`));

			// Count active/completed/done lenses
			let activeCount = 0;
			let doneCount = 0;
			let errorCount = 0;
			for (const lens of job.lenses) {
				const s = job.states.get(lens)!;
				if (s.status === "running") activeCount++;
				else if (s.status === "done") doneCount++;
				else if (s.status === "error") errorCount++;
			}
			const totalLenses = job.lenses.length;
			const progressText = theme.fg(
				"dim",
				`${doneCount + errorCount}/${totalLenses} complete` +
					(activeCount > 0 ? ` · ${activeCount} active` : ""),
			);
			lines.push(truncate(`  ${progressText}`));

			for (let i = 0; i < job.lenses.length; i++) {
				const lens = job.lenses[i];
				const s = job.states.get(lens)!;
				const isLast =
					i === job.lenses.length - 1 && job.synthesisStatus === "idle";
				const branch = isLast ? "└─" : "├─";
				lines.push(
					truncate(this.renderLensLine(branch, lens, s, theme, frame)),
				);
			}

			if (job.synthesisStatus !== "idle") {
				const icon =
					job.synthesisStatus === "running"
						? theme.fg("accent", frame)
						: job.synthesisStatus === "error"
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const synthElapsed =
					job.synthesisStatus === "running" && job.synthesisStartedAt
						? ` · ${formatElapsed(Date.now() - job.synthesisStartedAt)}`
						: "";
				const statusText =
					job.synthesisStatus === "running"
						? theme.fg("accent", `running${synthElapsed}`)
						: job.synthesisStatus === "error"
							? theme.fg("error", "failed")
							: theme.fg("dim", "done");
				lines.push(
					truncate(
						`${theme.fg("dim", "└─")} ${icon} ${theme.bold("Synthesis")} · ${statusText}`,
					),
				);
			}
		}

		return lines;
	}

	private renderLensLine(
		branch: string,
		lens: string,
		state: {
			status: LensStatus;
			modelName: string;
			durationMs: number;
			errorMessage?: string;
			findingsCount: number;
			logPath?: string;
			startedAt?: number;
			streamingText?: string;
		},
		theme: Theme,
		frame: string,
	): string {
		let icon: string;
		let statusText: string;
		let linkSegment = "";
		if (state.status === "queued") {
			icon = theme.fg("dim", "○");
			statusText = theme.fg("dim", "queued");
		} else if (state.status === "running") {
			icon = theme.fg("accent", frame);
			const elapsed = state.startedAt
				? ` · ${formatElapsed(Date.now() - state.startedAt)}`
				: "";
			statusText = state.streamingText
				? theme.fg("dim", state.streamingText.slice(0, 30))
				: theme.fg("accent", `running${elapsed}`);
		} else if (state.status === "done") {
			icon = theme.fg("success", "✓");
			const findings =
				state.findingsCount > 0 ? ` · ${state.findingsCount} findings` : "";
			statusText = theme.fg(
				"dim",
				`${(state.durationMs / 1000).toFixed(1)}s${findings}`,
			);
			linkSegment = renderLogLink(state.logPath, theme);
		} else {
			icon = theme.fg("error", "✗");
			statusText = theme.fg(
				"error",
				state.errorMessage ? state.errorMessage.slice(0, 40) : "error",
			);
			linkSegment = renderLogLink(state.logPath, theme);
		}

		const displayName = LENS_DISPLAY_NAMES[lens] ?? lens;
		const name = displayName.charAt(0).toUpperCase() + displayName.slice(1);
		const model = theme.fg("dim", `@ ${state.modelName}`);
		return `${theme.fg("dim", branch)} ${icon} ${theme.bold(name)} ${model} · ${statusText}${linkSegment}`;
	}

	private update() {
		if (!this.uiCtx?.setWidget) return;

		const hasActive = this.jobs.some(
			(j) => j.overallStatus === "running" || j.overallStatus === "queued",
		);

		if (!hasActive) {
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
