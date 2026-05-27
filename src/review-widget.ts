import { truncateToWidth } from "@earendil-works/pi-tui";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

interface LensState {
	status: "pending" | "running" | "done" | "error";
	modelName: string;
	durationMs: number;
	errorMessage?: string;
	findingsCount: number;
}

export class ReviewProgressWidget {
	private uiCtx: any;
	private widgetKey = "drykiss-review";
	private widgetRegistered = false;
	private tui: any;
	private timer: ReturnType<typeof setInterval> | undefined;
	private frame = 0;

	private lenses: readonly string[];
	private states: Map<string, LensState>;
	private synthesisStatus: "idle" | "running" | "done" = "idle";

	constructor(
		lenses: readonly string[],
		modelMap: Map<string, { name: string }>,
	) {
		this.lenses = lenses;
		this.states = new Map(
			lenses.map((l) => [
				l,
				{
					status: "pending",
					modelName: modelMap.get(l)?.name ?? "unknown",
					durationMs: 0,
					findingsCount: 0,
				},
			]),
		);
	}

	attach(uiCtx: any) {
		if (!uiCtx?.setWidget) return; // graceful degradation on older Pi
		this.uiCtx = uiCtx;
		this.ensureTimer();
		this.update();
	}

	setLensRunning(lens: string) {
		const s = this.states.get(lens);
		if (s) s.status = "running";
		this.update();
	}

	setLensDone(lens: string, durationMs: number, findingsCount: number) {
		const s = this.states.get(lens);
		if (s) {
			s.status = "done";
			s.durationMs = durationMs;
			s.findingsCount = findingsCount;
		}
		this.update();
	}

	setLensError(lens: string, errorMessage: string) {
		const s = this.states.get(lens);
		if (s) {
			s.status = "error";
			s.errorMessage = errorMessage;
		}
		this.update();
	}

	setSynthesizing() {
		this.synthesisStatus = "running";
		this.update();
	}

	setSynthesisDone() {
		this.synthesisStatus = "done";
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

		const lines: string[] = [
			truncate(theme.fg("accent", theme.bold("● DRYKISS Review"))),
		];

		for (let i = 0; i < this.lenses.length; i++) {
			const lens = this.lenses[i];
			const s = this.states.get(lens)!;
			const isLast =
				i === this.lenses.length - 1 && this.synthesisStatus === "idle";
			const branch = isLast ? "└─" : "├─";

			let icon: string;
			let statusText: string;
			if (s.status === "pending") {
				icon = theme.fg("dim", "○");
				statusText = theme.fg("dim", "pending");
			} else if (s.status === "running") {
				icon = theme.fg("accent", frame);
				statusText = theme.fg("accent", "running");
			} else if (s.status === "done") {
				icon = theme.fg("success", "✓");
				const findings =
					s.findingsCount > 0 ? ` · ${s.findingsCount} findings` : "";
				statusText = theme.fg(
					"dim",
					`${(s.durationMs / 1000).toFixed(1)}s${findings}`,
				);
			} else {
				icon = theme.fg("error", "✗");
				statusText = theme.fg(
					"error",
					s.errorMessage ? s.errorMessage.slice(0, 40) : "error",
				);
			}

			const name = lens.charAt(0).toUpperCase() + lens.slice(1);
			const model = theme.fg("dim", `@ ${s.modelName}`);
			lines.push(
				truncate(
					`${theme.fg("dim", branch)} ${icon} ${theme.bold(name)} ${model} · ${statusText}`,
				),
			);
		}

		if (this.synthesisStatus !== "idle") {
			const branch = "└─";
			if (this.synthesisStatus === "running") {
				lines.push(
					truncate(
						`${theme.fg("dim", branch)} ${theme.fg("accent", frame)} ${theme.bold("Synthesis")} ${theme.fg("dim", "· running")}`,
					),
				);
			} else {
				lines.push(
					truncate(
						`${theme.fg("dim", branch)} ${theme.fg("success", "✓")} ${theme.bold("Synthesis")} ${theme.fg("dim", "· done")}`,
					),
				);
			}
		}

		return lines;
	}

	private update() {
		if (!this.uiCtx?.setWidget) return;

		const allDone =
			this.lenses.every((l) => {
				const s = this.states.get(l)!;
				return s.status === "done" || s.status === "error";
			}) && this.synthesisStatus === "done";

		if (allDone) {
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
	}
}
