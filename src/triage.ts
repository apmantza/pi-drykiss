/**
 * Interactive post-review triage UI.
 *
 * After a review completes, this module presents each finding with three
 * choices: accept (acknowledge), dismiss (record a rejection so future
 * runs downrank it), or defer (add a time-limited suppression entry).
 *
 * Design choices:
 * - The triage step is purely additive: it never modifies or re-runs
 *   the review pipeline. It only writes to rejections.jsonl and/or the
 *   project config (suppressions).
 * - Each finding is presented one at a time via the Pi extension's
 *   `ctx.ui.custom()` overlay — the same mechanism used by the model
 *   selector. The user navigates with arrow keys and confirms with enter.
 * - When `ctx.ui.custom` is unavailable (headless mode, tests) the
 *   function resolves immediately with an empty summary so callers never
 *   break.
 * - "Dismiss" → `appendRejections` in rejections.jsonl (downranks the
 *   finding in future runs; never hides it).
 * - "Defer" → adds a `Suppression` entry with `expiresAt` set 30 days
 *   from now and `riskCode: "*"` matching the finding's file. Written
 *   to the project config via `saveProjectConfig`.
 * - "Accept" → no action (the user acknowledged the finding).
 * - "Skip all remaining" → exits triage early with a count of untriaged
 *   findings.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Text,
	Spacer,
	type SelectItem,
	SelectList,
} from "@earendil-works/pi-tui";
import type { Finding } from "./types.js";
import type { ReviewResult } from "./review-result.js";
import {
	appendRejections,
	toRejectionRecords,
} from "./rejections.js";
import { type Suppression, type DrykissConfig, saveProjectConfig, loadEffectiveConfig } from "./config.js";
import { LOG_PREFIX } from "./constants.js";

/** How many days a deferred finding's suppression stays active. */
export const DEFER_DAYS = 30;

/** Background colour for the triage overlay — matches model-selector styling. */
const BG_COLOR = (text: string): string =>
	`\x1b[48;2;0;20;137m${text}\x1b[0m`;

/** Action chosen for a single finding. */
export type TriageAction = "accept" | "dismiss" | "defer" | "skip";

/** Per-finding triage decision recorded in the summary. */
export interface TriageDecision {
	readonly finding: Finding;
	readonly action: TriageAction;
}

/** Summary returned after triage completes. */
export interface TriageSummary {
	readonly decisions: TriageDecision[];
	/** Findings the user accepted (acknowledged, no action taken). */
	readonly accepted: Finding[];
	/** Findings dismissed — written to rejections.jsonl. */
	readonly dismissed: Finding[];
	/** Findings deferred — a suppression entry with expiry was added. */
	readonly deferred: Finding[];
	/** Findings for which triage was not attempted (user skipped). */
	readonly skipped: Finding[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Format a finding into a compact label for the triage list header. */
function findingLabel(finding: Finding): string {
	const loc = finding.line ? `:${finding.line}` : "";
	const sev = finding.severity.toUpperCase();
	return `[${sev}] ${finding.file}${loc} — ${finding.summary}`;
}

/** Truncate text to `max` chars with an ellipsis. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

/** Wrap text at `maxWidth` chars, returning an array of lines. */
function wrapText(text: string, maxWidth: number): string[] {
	if (!text) return [""];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= maxWidth) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

// ── Single-finding triage prompt ─────────────────────────────────────────────

/** Options for the per-finding triage overlay. */
export interface TriageFindingOptions {
	/** 1-based index of the current finding. */
	current: number;
	/** Total number of findings being triaged. */
	total: number;
	finding: Finding;
}

/** Present a single-finding triage overlay. Returns the chosen action or null when the overlay API is unavailable. */
async function triageFinding(
	ctx: ExtensionContext,
	opts: TriageFindingOptions,
): Promise<TriageAction | null> {
	// Headless: no interactive UI available.
	if (typeof ctx.ui?.custom !== "function") return null;

	const { finding, current, total } = opts;
	const overlayWidth = 72;
	const textWidth = overlayWidth - 4; // 2-char indent each side

	const items: SelectItem[] = [
		{
			value: "accept",
			label: "Accept",
			description: "Acknowledge this finding; no action recorded",
		},
		{
			value: "dismiss",
			label: "Dismiss",
			description: "Record as not-actionable; future runs will downrank it",
		},
		{
			value: "defer",
			label: `Defer ${DEFER_DAYS} days`,
			description: `Add a temporary suppression that expires in ${DEFER_DAYS} days`,
		},
		{
			value: "skip",
			label: "Skip remaining",
			description: "Exit triage now; remaining findings left untriaged",
		},
	];

	try {
		const result = await ctx.ui.custom<TriageAction | null>(
			(_tui: any, theme: any, _kb: any, done: (v: TriageAction | null) => void) => {
				const box = new Box(1, 1, BG_COLOR);

				// Header
				box.addChild(
					new Text(
						theme.fg(
							"accent",
							theme.bold(
								`DRYKISS Triage  (${current}/${total})`,
							),
						),
						1,
						0,
					),
				);
				box.addChild(new Spacer(1));

				// Severity + location
				const sev = finding.severity.toUpperCase();
				const loc = finding.line ? `:${finding.line}` : "";
				const sevColor =
					finding.severity === "critical" || finding.severity === "high"
						? "error"
						: finding.severity === "medium"
							? "warning"
							: "dim";
				box.addChild(
					new Text(
						theme.fg(sevColor, `[${sev}]`) +
							" " +
							theme.fg("dim", `${finding.file}${loc}`),
						1,
						0,
					),
				);
				box.addChild(new Spacer(1));

				// Summary (wrapped)
				for (const line of wrapText(finding.summary, textWidth)) {
					box.addChild(new Text(theme.bold(truncate(line, textWidth)), 1, 0));
				}
				box.addChild(new Spacer(1));

				// Detail (wrapped, muted, max 4 lines)
				const detailLines = wrapText(finding.detail, textWidth).slice(0, 4);
				for (const line of detailLines) {
					box.addChild(new Text(theme.fg("muted", truncate(line, textWidth)), 1, 0));
				}
				box.addChild(new Spacer(1));

				// Suggestion
				if (finding.suggestion) {
					box.addChild(
						new Text(theme.fg("dim", "Suggestion:"), 1, 0),
					);
					for (const line of wrapText(finding.suggestion, textWidth).slice(0, 3)) {
						box.addChild(
							new Text(theme.fg("dim", truncate(line, textWidth)), 1, 0),
						);
					}
					box.addChild(new Spacer(1));
				}

				// Action selector
				const selectList = new (SelectList as any)(
					items,
					Math.min(items.length, 6),
					{
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
					{ minPrimaryColumnWidth: 20 },
				);

				selectList.onSelect = (item: SelectItem) =>
					done(item.value as TriageAction);
				selectList.onCancel = () => done(null);
				box.addChild(selectList);

				box.addChild(new Spacer(1));
				box.addChild(
					new Text(
						theme.fg("dim", "↑↓ navigate · enter select · esc cancel triage"),
						1,
						0,
					),
				);

				const maxHeight = 30;
				return {
					render: (w: number) => {
						const rendered = box.render(w);
						const padLine = BG_COLOR(" ".repeat(w));
						while (rendered.length < maxHeight) rendered.push(padLine);
						return rendered;
					},
					invalidate: () => box.invalidate(),
					handleInput: (data: string) => selectList.handleInput(data),
				};
			},
			{
				overlay: true,
				overlayOptions: {
					width: overlayWidth,
					maxHeight: 30,
					anchor: "center",
				},
			},
		);

		return result ?? null;
	} catch (err) {
		console.warn(
			`${LOG_PREFIX} Triage overlay error for finding "${truncate(finding.summary, 60)}": ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

// ── Defer: add a suppression entry ───────────────────────────────────────────

/**
 * Add a suppression entry for a deferred finding.
 *
 * The suppression targets the finding's exact file path with a wildcard
 * riskCode ("*") so it covers any lens for that file. It expires after
 * DEFER_DAYS days. The project config is read, merged, and re-written.
 *
 * On any error this function logs and returns; deferring must never
 * break the review pipeline.
 */
async function addDeferSuppression(
	cwd: string,
	finding: Finding,
	existingSuppressions: Suppression[],
): Promise<Suppression[]> {
	const addedAt = new Date().toISOString();
	const expiresAt = new Date(
		Date.now() + DEFER_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();

	const entry: Suppression = {
		id: randomUUID(),
		riskCode: finding.riskCode ?? "*",
		pattern: finding.file,
		reason: `Deferred via triage: ${truncate(finding.summary, 120)}`,
		addedAt,
		expiresAt,
	};

	const updated = [...existingSuppressions, entry];

	try {
		await saveProjectConfig(cwd, { suppressions: updated });
	} catch (err) {
		console.warn(
			`${LOG_PREFIX} Failed to save deferred suppression for ${finding.file}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return updated;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run interactive post-review triage for each finding in `result`.
 *
 * The caller controls which findings are offered for triage via the
 * `findings` option. When omitted, only active (non-suppressed,
 * non-rejected) findings are presented.
 *
 * Returns a TriageSummary describing every decision made. If the
 * interactive UI is unavailable or no findings exist, resolves
 * immediately with an empty summary (all findings in `skipped`).
 */
export async function runTriage(
	result: ReviewResult,
	ctx: ExtensionContext,
	cwd: string,
	options: {
		/** Override which findings are triaged. Defaults to active (non-suppressed, non-rejected) findings. */
		findings?: Finding[];
	} = {},
): Promise<TriageSummary> {
	// Identify the findings to triage: skip suppressed + previously-rejected by default.
	const candidates: Finding[] =
		options.findings ??
		result.findings.filter(
			(f) => !f._suppressed && !f._previouslyRejected,
		);

	const empty: TriageSummary = {
		decisions: [],
		accepted: [],
		dismissed: [],
		deferred: [],
		skipped: [...candidates],
	};

	if (candidates.length === 0) return empty;
	if (typeof ctx.ui?.custom !== "function") return empty;

	const decisions: TriageDecision[] = [];
	const accepted: Finding[] = [];
	const dismissed: Finding[] = [];
	const deferred: Finding[] = [];
	const skipped: Finding[] = [];

	// Load existing suppressions once so deferred findings accumulate correctly.
	let currentSuppressions: Suppression[] = [];
	try {
		const { config } = await loadEffectiveConfig(cwd);
		currentSuppressions = [...(config.suppressions ?? [])];
	} catch (err) {
		console.warn(
			`${LOG_PREFIX} Triage could not load project config; defer will still attempt to write: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	for (let i = 0; i < candidates.length; i++) {
		const finding = candidates[i];
		const action = await triageFinding(ctx, {
			current: i + 1,
			total: candidates.length,
			finding,
		});

		if (action === null) {
			// Overlay unavailable or closed without selection — skip all remaining.
			for (let j = i; j < candidates.length; j++) {
				skipped.push(candidates[j]);
				decisions.push({ finding: candidates[j], action: "skip" });
			}
			break;
		}

		decisions.push({ finding, action });

		if (action === "accept") {
			accepted.push(finding);
		} else if (action === "dismiss") {
			dismissed.push(finding);
			// Persist immediately so a crash mid-triage still records progress.
			try {
				const records = toRejectionRecords([finding], { source: "user" });
				await appendRejections(cwd, records);
			} catch (err) {
				console.warn(
					`${LOG_PREFIX} Failed to persist dismissal for ${finding.file}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else if (action === "defer") {
			deferred.push(finding);
			try {
				currentSuppressions = await addDeferSuppression(
					cwd,
					finding,
					currentSuppressions,
				);
			} catch (err) {
				console.warn(
					`${LOG_PREFIX} Failed to defer finding for ${finding.file}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			// "skip" — user chose to exit triage early.
			skipped.push(finding);
			// Push remaining as skipped too.
			for (let j = i + 1; j < candidates.length; j++) {
				skipped.push(candidates[j]);
				decisions.push({ finding: candidates[j], action: "skip" });
			}
			break;
		}
	}

	return { decisions, accepted, dismissed, deferred, skipped };
}

/**
 * Format a triage summary as a compact human-readable string suitable
 * for appending to the review output or tool result text.
 */
export function formatTriageSummary(summary: TriageSummary): string {
	const { accepted, dismissed, deferred, skipped } = summary;
	if (summary.decisions.length === 0) return "";
	const parts: string[] = [];
	if (accepted.length > 0) parts.push(`${accepted.length} accepted`);
	if (dismissed.length > 0) parts.push(`${dismissed.length} dismissed`);
	if (deferred.length > 0)
		parts.push(`${deferred.length} deferred (${DEFER_DAYS} days)`);
	if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
	return `\nDRYKISS Triage: ${parts.join(", ")}.`;
}
