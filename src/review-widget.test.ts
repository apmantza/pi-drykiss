import { describe, expect, it } from "vitest";
import { ReviewProgressWidget } from "./review-widget.js";
import type { LensState, ReviewJob } from "./review-manager.js";
import type { ReviewLens } from "./types.js";

function buildRunningJob(elapsedMs: number): ReviewJob {
	const lens: ReviewLens = "simplicity";
	const state: LensState = {
		status: "running",
		modelName: "m",
		durationMs: 0,
		findingsCount: 0,
		rawOutput: "",
		startedAt: Date.now() - elapsedMs,
	};
	return {
		id: "j",
		files: [],
		lenses: [lens],
		states: new Map([[lens, state]]),
		synthesisStatus: "idle",
		overallStatus: "running",
		startedAt: Date.now(),
	};
}

function renderElapsedLine(elapsedMs: number): string {
	let captured: (() => string[]) | undefined;
	const widget = new ReviewProgressWidget();
	const theme = {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};
	const uiCtx = {
		setWidget: (
			_key: string,
			fn: (tui: any, theme: any) => { render: () => string[] },
		) => {
			captured = () => fn({ terminal: { columns: 200 } }, theme).render();
		},
	};
	widget.attach(uiCtx);
	widget.setJobs([buildRunningJob(elapsedMs)]);
	const lines = captured?.() ?? [];
	widget.dispose();
	// Heading, progress, then the lens line.
	const lensLine = lines[2] ?? "";
	const match = lensLine.match(/running\s*·\s*(.+)$/);
	return match ? match[1].trim() : "";
}

describe("formatElapsed (via widget render)", () => {
	it("formats sub-minute durations as X.Ys", () => {
		expect(renderElapsedLine(500)).toBe("0.5s");
		expect(renderElapsedLine(12_300)).toBe("12.3s");
		expect(renderElapsedLine(59_900)).toBe("59.9s");
	});

	it("switches to Xm YYs at the one-minute mark", () => {
		expect(renderElapsedLine(60_000)).toBe("1m 00s");
		expect(renderElapsedLine(75_000)).toBe("1m 15s");
		expect(renderElapsedLine(125_000)).toBe("2m 05s");
	});

	it("switches to Xh YYm past one hour", () => {
		expect(renderElapsedLine(3_600_000)).toBe("1h 00m");
		expect(renderElapsedLine(3_900_000)).toBe("1h 05m");
	});

	it("renders 0.0s for a lens that just started", () => {
		expect(renderElapsedLine(0)).toBe("0.0s");
	});

	it("omits the elapsed suffix for lenses without startedAt", () => {
		// Build a job whose lens state has no startedAt (legacy / pre-status-change).
		const lens: ReviewLens = "simplicity";
		const state: LensState = {
			status: "running",
			modelName: "m",
			durationMs: 0,
			findingsCount: 0,
			rawOutput: "",
		};
		const job: ReviewJob = {
			...buildRunningJob(0),
			states: new Map([[lens, state]]),
		};
		let captured: (() => string[]) | undefined;
		const widget = new ReviewProgressWidget();
		const theme = {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
		};
		const uiCtx = {
			setWidget: (
				_key: string,
				fn: (tui: any, theme: any) => { render: () => string[] },
			) => {
				captured = () => fn({ terminal: { columns: 200 } }, theme).render();
			},
		};
		widget.attach(uiCtx);
		widget.setJobs([job]);
		const lensLine = (captured?.() ?? [])[2] ?? "";
		widget.dispose();
		// Should show "running" with NO elapsed suffix.
		expect(lensLine).toMatch(/·\s*running\s*$/);
		expect(lensLine).not.toMatch(/running\s*·/);
	});
});
