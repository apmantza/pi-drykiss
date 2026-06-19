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

describe("renderLensLine — provider display", () => {
	const lens: ReviewLens = "simplicity";

	function buildJobWithState(state: LensState): ReviewJob {
		return {
			id: "j2",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "idle",
			overallStatus: "running",
			startedAt: Date.now(),
		};
	}

	it("renders provider/modelName together when provider is set", () => {
		const job = buildJobWithState(
			buildLensState({
				status: "running",
				startedAt: Date.now() - 1000,
				modelName: "Claude Sonnet 4",
				provider: "anthropic",
			}),
		);
		const line = renderJobLine(job);
		// Provider and model joined as `provider/modelName` so users can
		// tell which provider served this lens at a glance.
		expect(line).toContain("@ anthropic/Claude Sonnet 4");
	});

	it("falls back to modelName alone when provider is missing", () => {
		// Legacy lens states from persisted reviews don't have a
		// provider field — the widget must still render the model name
		// without crashing or showing an empty slash.
		const job = buildJobWithState(
			buildLensState({
				status: "running",
				startedAt: Date.now() - 1000,
				modelName: "Claude Sonnet 4",
			}),
		);
		const line = renderJobLine(job);
		expect(line).toContain("@ Claude Sonnet 4");
		expect(line).not.toContain("/Claude Sonnet 4");
	});

	it("treats whitespace-only provider as missing", () => {
		const job = buildJobWithState(
			buildLensState({
				status: "running",
				startedAt: Date.now() - 1000,
				modelName: "GPT-4o",
				provider: "   ",
			}),
		);
		const line = renderJobLine(job);
		expect(line).toContain("@ GPT-4o");
		expect(line).not.toContain("/GPT-4o");
	});

	it("renders provider/modelName for a done lens", () => {
		const job = buildJobWithState(
			buildLensState({
				status: "done",
				durationMs: 4200,
				findingsCount: 3,
				modelName: "Haiku",
				provider: "anthropic",
			}),
		);
		const line = renderJobLine(job);
		expect(line).toContain("@ anthropic/Haiku");
		expect(line).toContain("3 findings");
	});
});

describe("renderWidget — completed summary", () => {
	function renderAll(job: ReviewJob): string[] {
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
		return lines;
	}

	function buildCompletedJob(
		overrides: Partial<ReviewJob> & {
			synthesisResult?: any;
			overallStatus?: ReviewJob["overallStatus"];
		} = {},
	): ReviewJob {
		const lens: ReviewLens = "simplicity";
		const state: LensState = buildLensState({
			status: "done",
			durationMs: 4200,
			findingsCount: 3,
			modelName: "Claude Sonnet 4",
			provider: "anthropic",
		});
		return {
			id: "j3",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "done",
			overallStatus: overrides.overallStatus ?? "done",
			startedAt: Date.now() - 5000,
			completedAt: Date.now(),
			...(overrides.synthesisResult
				? { synthesisResult: overrides.synthesisResult }
				: {
						synthesisResult: {
							findings: [],
							summary: "ok",
							verdict: "Approve",
							criticalCount: 0,
							highCount: 0,
							mediumCount: 0,
							lowCount: 0,
							nitCount: 0,
							healthScore: 92,
							scoreBreakdown: { critical: 0, warning: 0, suggestion: 0 },
						},
					}),
			...overrides,
		};
	}

	it("renders a compact summary line for a completed job (not running/queued)", () => {
		const lines = renderAll(buildCompletedJob());
		// First line is the heading with the verdict.
		expect(lines[0]).toContain("DRYKISS Review");
		expect(lines[0]).toContain("Verdict: Approve");
		// Stats line includes the health score.
		const statsLine = lines[1] ?? "";
		expect(statsLine).toContain("0 findings");
		expect(statsLine).toContain("score 92/100");
		// Model/provider line comes after.
		expect(lines[2]).toContain("@ anthropic/Claude Sonnet 4");
	});

	it("includes critical/high counts in the stats line when present", () => {
		const lines = renderAll(
			buildCompletedJob({
				synthesisResult: {
					findings: [],
					summary: "needs work",
					verdict: "Request changes",
					criticalCount: 2,
					highCount: 5,
					mediumCount: 0,
					lowCount: 0,
					nitCount: 0,
					healthScore: 35,
					scoreBreakdown: { critical: 2, warning: 5, suggestion: 0 },
				},
			}),
		);
		const statsLine = lines[1] ?? "";
		expect(statsLine).toContain("2 critical");
		expect(statsLine).toContain("5 high");
		expect(statsLine).toContain("score 35/100");
	});

	it("lists multiple distinct provider/model pairs separated by comma", () => {
		const lens1: ReviewLens = "simplicity";
		const lens2: ReviewLens = "deduplication";
		const job = buildCompletedJob({
			lenses: [lens1, lens2],
			states: new Map([
				[
					lens1,
					buildLensState({
						status: "done",
						modelName: "Claude Sonnet 4",
						provider: "anthropic",
						durationMs: 3000,
						findingsCount: 2,
					}),
				],
				[
					lens2,
					buildLensState({
						status: "done",
						modelName: "GPT-4o",
						provider: "openai",
						durationMs: 4000,
						findingsCount: 1,
					}),
				],
			]),
		});
		const lines = renderAll(job);
		const modelLine = lines.find((l) => l.includes("@")) ?? "";
		// Both provider/model pairs must appear, regardless of order
		// (Set iteration is insertion order, which here is lens order).
		expect(modelLine).toContain("anthropic/Claude Sonnet 4");
		expect(modelLine).toContain("openai/GPT-4o");
	});

	it("omits the model line when no lenses have a provider or modelName", () => {
		const lens: ReviewLens = "simplicity";
		const job = buildCompletedJob({
			states: new Map([
				[
					lens,
					buildLensState({
						status: "done",
						modelName: "", // explicit empty — buildLensState defaults to "m"
					}),
				],
			]),
		});
		const lines = renderAll(job);
		// Should have heading + stats, but no model line.
		expect(lines.length).toBe(2);
		expect(lines.some((l) => l.startsWith("@"))).toBe(false);
	});

	it("handles errored jobs with a red icon and missing synthesis", () => {
		const lens: ReviewLens = "simplicity";
		const state: LensState = buildLensState({
			status: "error",
			errorMessage: "boom",
			modelName: "Sonnet",
			provider: "anthropic",
		});
		const job: ReviewJob = {
			id: "j4",
			files: [],
			lenses: [lens],
			states: new Map([[lens, state]]),
			synthesisStatus: "error",
			overallStatus: "error",
			startedAt: Date.now() - 5000,
			completedAt: Date.now(),
		};
		const lines = renderAll(job);
		// Heading should still render; the widget doesn't crash when
		// synthesis is missing on an errored job.
		expect(lines[0]).toContain("DRYKISS Review");
		expect(lines[0]).toContain("Request changes"); // fallback verdict
	});

	it("renders the elapsed duration for completed jobs", () => {
		const lines = renderAll(buildCompletedJob());
		const statsLine = lines[1] ?? "";
		// startedAt is 5s ago, completedAt is now → ~5s elapsed
		expect(statsLine).toMatch(/\d+\.\ds/);
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
