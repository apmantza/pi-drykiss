import { describe, expect, it } from "vitest";
import { ReviewProgressWidget } from "./review-widget.js";
import type { LensState, ReviewJob } from "./review-manager.js";
import type { ReviewLens } from "./types.js";

function buildLensState(overrides: Partial<LensState>): LensState {
	return {
		status: "queued",
		modelName: "m",
		durationMs: 0,
		findingsCount: 0,
		rawOutput: "",
		...overrides,
	};
}

function renderJobLine(job: ReviewJob, lineIndex = 2): string {
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
	const lines = captured?.() ?? [];
	widget.dispose();
	return lines[lineIndex] ?? "";
}

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

describe("renderLensLine — session log link", () => {
	const lens: ReviewLens = "simplicity";

	function buildJobWithState(state: LensState): ReviewJob {
		return {
			id: "j1",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "idle",
			overallStatus: "running",
			startedAt: Date.now(),
		};
	}

	it("appends an OSC 8 hyperlink to the basename for a done lens with logPath", () => {
		const job = buildJobWithState(
			buildLensState({
				status: "done",
				durationMs: 8400,
				findingsCount: 5,
				logPath: "/home/user/.pi/drykiss/sessions/j1-simplicity.jsonl",
			}),
		);
		const line = renderJobLine(job);
		// Hyperlink escape sequence: ESC ] 8 ; ; <url> ESC \
		expect(line).toContain("\x1b]8;;file://");
		expect(line).toContain("j1-simplicity.jsonl");
		// pathToFileURL adds a drive letter on Windows but not on Linux/macOS.
		// Verify the file:// scheme + path components, drive letter optional.
		expect(line).toMatch(
			/file:\/\/\/(?:[A-Z]:)?[^ ]*\.pi[\\/]drykiss[\\/]sessions/,
		);
	});

	it("appends the link for an errored lens with logPath", () => {
		const job = buildJobWithState(
			buildLensState({
				status: "error",
				errorMessage: "boom",
				logPath: "/home/user/.pi/drykiss/sessions/j1-simplicity.jsonl",
			}),
		);
		const line = renderJobLine(job);
		expect(line).toContain("\x1b]8;;");
		expect(line).toContain("j1-simplicity.jsonl");
	});

	it("does NOT append a link for a done lens without logPath", () => {
		const job = buildJobWithState(
			buildLensState({ status: "done", durationMs: 1000, findingsCount: 0 }),
		);
		const line = renderJobLine(job);
		expect(line).not.toContain("\x1b]8;;");
		expect(line).not.toContain(".jsonl");
	});

	it("does NOT append a link for a running lens even if logPath is set", () => {
		const job = buildJobWithState(
			buildLensState({
				status: "running",
				startedAt: Date.now() - 1000,
				logPath: "/some/path.jsonl", // shouldn't happen, but defensive
			}),
		);
		const line = renderJobLine(job);
		expect(line).not.toContain("\x1b]8;;");
	});

	it("does NOT append a link for a queued lens", () => {
		const job = buildJobWithState(buildLensState({ status: "queued" }));
		const line = renderJobLine(job);
		expect(line).not.toContain("\x1b]8;;");
	});
});

import { formatFinding } from "./review-widget.js";
import type { Finding } from "./types.js";

describe("formatFinding", () => {
	function buildFinding(overrides: Partial<Finding> = {}): Finding {
		return {
			file: "src/user.ts",
			line: 42,
			severity: "high",
			category: "Divergent Change",
			summary: "Two call sites diverge",
			detail: "update_profile and update_admin both fork on the same field.",
			suggestion: "Extract a shared helper.",
			consequence: "Future changes will be missed in one branch.",
			source: "UserService.update_profile",
			fixability: "guided",
			riskCode: "R1",
			lens: "simplicity",
			...overrides,
		};
	}

	it("renders the heading with severity icon, lens tag, category, source, and location", () => {
		const out = formatFinding(buildFinding());
		const firstLine = out.split("\n")[0];
		expect(firstLine).toBe(
			"🟠 [KISS] Divergent Change — UserService.update_profile (src/user.ts:42)",
		);
	});

	it("includes the Symptom line with detail", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain(
			"Symptom: update_profile and update_admin both fork on the same field.",
		);
	});

	it("includes the Consequence line when consequence is set", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain(
			"→ Consequence: Future changes will be missed in one branch.",
		);
	});

	it("includes the Fix line with fixability label and suggestion", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain(
			"→ Fix: guided (~10 lines) — Extract a shared helper.",
		);
	});

	it("includes the riskCode annotation when set", () => {
		const out = formatFinding(buildFinding());
		expect(out).toContain("[riskCode: R1]");
	});

	it("omits the Consequence line for legacy findings without one", () => {
		const out = formatFinding(
			buildFinding({ consequence: undefined, source: undefined }),
		);
		expect(out).not.toContain("Consequence");
	});

	it("omits the Fix line when suggestion is empty", () => {
		const out = formatFinding(buildFinding({ suggestion: "" }));
		expect(out).not.toContain("→ Fix:");
	});

	it("falls back to plain '→ Fix: <suggestion>' when fixability is missing", () => {
		const out = formatFinding(buildFinding({ fixability: undefined }));
		expect(out).toContain("→ Fix: Extract a shared helper.");
		expect(out).not.toContain("(~10 lines)");
	});

	it("uses different severity icons", () => {
		expect(
			formatFinding(buildFinding({ severity: "critical" })).split("\n")[0],
		).toMatch(/^🔴/);
		expect(
			formatFinding(buildFinding({ severity: "medium" })).split("\n")[0],
		).toMatch(/^🟡/);
		expect(
			formatFinding(buildFinding({ severity: "low" })).split("\n")[0],
		).toMatch(/^🔵/);
		expect(
			formatFinding(buildFinding({ severity: "nit" })).split("\n")[0],
		).toMatch(/^⚪/);
	});

	it("omits line number from location when line is undefined", () => {
		const out = formatFinding(buildFinding({ line: undefined }));
		expect(out.split("\n")[0]).toContain("(src/user.ts)");
		expect(out.split("\n")[0]).not.toContain("src/user.ts:42");
	});

	it("uses the lens display name from LENS_DISPLAY_NAMES", () => {
		const out = formatFinding(buildFinding({ lens: "deduplication" }));
		expect(out).toContain("[DRY]");
		expect(out).not.toContain("[deduplication]");
	});

	it("falls back to the raw lens name when unknown", () => {
		const out = formatFinding(buildFinding({ lens: "simplicity" }));
		// simplicity → "KISS" via LENS_DISPLAY_NAMES
		expect(out).toContain("[KISS]");
	});
});
