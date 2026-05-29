import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ReviewJob, LensStatus } from "./review-manager.js";
import { LENS_DISPLAY_NAMES } from "./constants.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
				const statusText =
					job.synthesisStatus === "running"
						? theme.fg("accent", "running")
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
			streamingText?: string;
		},
		theme: Theme,
		frame: string,
	): string {
		let icon: string;
		let statusText: string;
		if (state.status === "queued") {
			icon = theme.fg("dim", "○");
			statusText = theme.fg("dim", "queued");
		} else if (state.status === "running") {
			icon = theme.fg("accent", frame);
			statusText = state.streamingText
				? theme.fg("dim", state.streamingText.slice(0, 30))
				: theme.fg("accent", "running");
		} else if (state.status === "done") {
			icon = theme.fg("success", "✓");
			const findings =
				state.findingsCount > 0 ? ` · ${state.findingsCount} findings` : "";
			statusText = theme.fg(
				"dim",
				`${(state.durationMs / 1000).toFixed(1)}s${findings}`,
			);
		} else {
			icon = theme.fg("error", "✗");
			statusText = theme.fg(
				"error",
				state.errorMessage ? state.errorMessage.slice(0, 40) : "error",
			);
		}

		const displayName = LENS_DISPLAY_NAMES[lens] ?? lens;
		const name = displayName.charAt(0).toUpperCase() + displayName.slice(1);
		const model = theme.fg("dim", `@ ${state.modelName}`);
		return `${theme.fg("dim", branch)} ${icon} ${theme.bold(name)} ${model} · ${statusText}`;
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
