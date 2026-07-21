import type { ReviewJob } from "./review-manager.js";
import { LENS_DISPLAY_NAMES } from "./constants.js";
import { stripAnsi } from "./content-utils.js";
import { logAutoreviewError } from "./logger.js";
import type { Finding, Severity } from "./types.js";
import { RISK_CODES } from "./prompts/risk-codes.js";

/**
 * Format a millisecond duration as a compact elapsed-time string. */
function formatElapsed(ms: number): string {
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
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

/** Strip terminal controls from repository/model-supplied display text. */
function sanitizeTerminalText(text: string): string {
	return stripAnsi(text).replace(/[\u0000-\u001f\u007f]/g, "");
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
interface ModelPairSource {
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
 * missing or non-string. Shared by display helpers so all surfaces
 * agree on "what verdict do we show for a job with no synthesis verdict?"
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
 * a blank "Verdict:" line.
 */
export function pickVerdict(
	synthesisVerdict: unknown,
	hasError: boolean,
): string {
	const verdict =
		typeof synthesisVerdict === "string" ? synthesisVerdict.trim() : "";
	if (verdict.length > 0) {
		return verdict;
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
	const lensName = sanitizeTerminalText(
		finding.lens
			? (LENS_DISPLAY_NAMES[finding.lens] ?? finding.lens)
			: "Review",
	);
	const icon = SEVERITY_ICON[finding.severity] ?? "⚪";
	const tag = theme.fg("accent", `[${lensName}]`);
	const category = theme.bold(sanitizeTerminalText(finding.category));
	const source = sanitizeTerminalText(finding.source ?? "");
	const file = sanitizeTerminalText(finding.file);
	const location = finding.line ? ` (${file}:${finding.line})` : ` (${file})`;
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

/** Severity order for consistent group rendering (critical first, nit last). */
const SEVERITY_ORDER: Severity[] = [
	"critical",
	"high",
	"medium",
	"low",
	"nit",
];

/**
 * Group a list of findings by their `riskCode` field.
 *
 * Returns an ordered array of `[riskCode | null, findings[]]` pairs:
 *   - Named groups (e.g. "R1", "K1") appear in the order they are first
 *     encountered, with the catalogue name resolved from RISK_CODES.
 *   - A final `null` bucket collects findings that have no `riskCode`.
 *
 * The null bucket is omitted when it would be empty.
 */
export function groupFindingsByRiskCode(
	findings: readonly Finding[],
): Array<{ riskCode: string | null; name: string; findings: Finding[] }> {
	const codeOrder: string[] = [];
	const byCode = new Map<string, Finding[]>();
	const noCode: Finding[] = [];

	for (const f of findings) {
		if (f.riskCode) {
			if (!byCode.has(f.riskCode)) {
				byCode.set(f.riskCode, []);
				codeOrder.push(f.riskCode);
			}
			byCode.get(f.riskCode)!.push(f);
		} else {
			noCode.push(f);
		}
	}

	const groups: Array<{
		riskCode: string | null;
		name: string;
		findings: Finding[];
	}> = [];

	for (const code of codeOrder) {
		const codeDef = (RISK_CODES as Record<string, { name: string } | undefined>)[
			code
		];
		const name = codeDef ? codeDef.name : code;
		groups.push({ riskCode: code, name, findings: byCode.get(code)! });
	}

	if (noCode.length > 0) {
		groups.push({ riskCode: null, name: "Other", findings: noCode });
	}

	return groups;
}

/**
 * Format a severity-then-risk-code grouped block of findings as a
 * human-readable multi-line string.
 *
 * Grouping behaviour:
 *   - Findings are first partitioned by severity in canonical order
 *     (critical → high → medium → low → nit). Empty severity buckets
 *     are skipped.
 *   - Within each severity bucket, findings are sub-grouped by
 *     `riskCode`. This secondary grouping is applied when
 *     `options.groupByRiskCode` is `true`, OR when at least one finding
 *     in the input set carries a non-empty `riskCode` (opt-in by
 *     presence). Pass `options.groupByRiskCode = false` to force-disable
 *     the sub-grouping even when risk codes are present.
 *   - Sub-group headers look like: `  [K1] KISS violations (3)`
 *   - Findings without a riskCode go into an "Other" sub-group rendered
 *     last within their severity bucket.
 *
 * @param findings - Full list of findings to render (all severities).
 * @param theme    - Colour theme injected by the caller (defaults to no-op).
 * @param options  - Optional rendering flags.
 */
export function formatFindingsGrouped(
	findings: readonly Finding[],
	theme: FindingTheme = defaultTheme,
	options: { groupByRiskCode?: boolean } = {},
): string {
	if (findings.length === 0) return "";

	// Determine whether to apply risk-code sub-grouping.
	const hasAnyriskCode = findings.some((f) => f.riskCode);
	const useRiskCodeGroups =
		options.groupByRiskCode !== undefined
			? options.groupByRiskCode
			: hasAnyriskCode;

	const sections: string[] = [];

	for (const sev of SEVERITY_ORDER) {
		const bucket = findings.filter((f) => f.severity === sev);
		if (bucket.length === 0) continue;

		const sevLabel =
			sev.charAt(0).toUpperCase() + sev.slice(1);
		sections.push(
			theme.bold(`── ${sevLabel} (${bucket.length}) ──`),
		);

		if (useRiskCodeGroups) {
			const riskGroups = groupFindingsByRiskCode(bucket);
			for (const group of riskGroups) {
				const badge =
					group.riskCode !== null
						? `[${group.riskCode}] ${group.name}`
						: "Other";
				sections.push(
					`  ${theme.fg("accent", badge)} (${group.findings.length})`,
				);
				for (const f of group.findings) {
					// Indent each finding line by two extra spaces to nest
					// visually under the sub-group header.
					const rendered = formatFinding(f, theme)
						.split("\n")
						.map((line) => `  ${line}`)
						.join("\n");
					sections.push(rendered);
				}
			}
		} else {
			for (const f of bucket) {
				sections.push(formatFinding(f, theme));
			}
		}
	}

	return sections.join("\n");
}

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

/** Format the aggregate review state for Pi's single built-in working row.
 *
 * Replaces the static "DRYKISS Review" label with the name(s) of the
 * actively-running lens (or "Synthesis" / "Review starting" depending
 * on the current phase) so the user sees what's happening at a glance
 * without a separate widget row.
 */
export function formatReviewWorkingMessage(job: ReviewJob): string {
	let completedOrErrorCount = 0;
	const runningLenses: string[] = [];
	for (const lens of job.lenses) {
		const state = job.states.get(lens);
		if (state?.status === "running") {
			runningLenses.push(LENS_DISPLAY_NAMES[lens] ?? lens);
		} else if (state?.status === "done" || state?.status === "error") {
			completedOrErrorCount++;
		}
	}
	const totalLenses = job.lenses.length;
	const barWidth = 10;
	const filled =
		totalLenses === 0
			? 0
			: Math.min(
					barWidth,
					Math.round((completedOrErrorCount / totalLenses) * barWidth),
				);
	const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
	const elapsed =
		job.overallStatus === "running" && job.startedAt
			? ` · ${formatElapsed(Date.now() - job.startedAt)}`
			: "";

	// Determine the phase label: running lens names, "Synthesis" when
	// all lenses are done, or "Review starting" when nothing is running yet.
	const phaseLabel =
		runningLenses.length > 0
			? `${runningLenses.join(", ")} running`
			: completedOrErrorCount === totalLenses && totalLenses > 0
				? "Synthesizing"
				: "Review starting";

	return (
		`${phaseLabel} · ${job.files.length} file(s) · ` +
		`[${bar}] ${completedOrErrorCount}/${totalLenses} complete` +
		elapsed
	);
}

export class ReviewProgressWidget {
	private uiCtx: any;
	private readonly widgetKey = "drykiss-review";
	private widgetRegistered = false;
	private tui: any;
	private jobs: ReviewJob[] = [];
	private readonly pendingBackgrounds = new Map<string, number>();

	beginBackgroundReview(id: string): void {
		this.pendingBackgrounds.set(id, Date.now());
		this.update();
	}

	endBackgroundReview(id: string): void {
		this.pendingBackgrounds.delete(id);
		this.update();
	}

	attach(uiCtx: any) {
		if (!uiCtx?.setWidget) return;
		this.uiCtx = uiCtx;
		this.update();
	}

	setJobs(jobs: ReviewJob[]) {
		this.jobs = jobs;
		this.update();
	}

	private renderWidget(): string[] {
		// Render active progress here rather than relying on Pi's transient
		// working-message row, which may disappear when the tool call returns.
		const liveLines = this.jobs
			.filter(
				(job) =>
					job.overallStatus === "running" || job.overallStatus === "queued",
			)
			.map(formatReviewWorkingMessage);
		if (liveLines.length > 0) return liveLines;
		return [...this.pendingBackgrounds.entries()].map(([, startedAt]) => {
			const elapsed = formatElapsed(Date.now() - startedAt);
			return `Review starting · [${"░".repeat(10)}] 0/— complete · ${elapsed}`;
		});
	}

	private update() {
		if (!this.uiCtx?.setWidget) return;

		const hasLive =
			this.pendingBackgrounds.size > 0 ||
			this.jobs.some(
				(j) => j.overallStatus === "running" || j.overallStatus === "queued",
			);
		if (!hasLive) {
			this.dispose();
			return;
		}

		if (!this.widgetRegistered) {
			try {
				this.uiCtx.setWidget(
					this.widgetKey,
					(tui: any, _theme: Theme) => {
						this.tui = tui;
						return {
							render: () => {
								try {
									return this.renderWidget();
								} catch (err) {
									logAutoreviewError("widget.render_error", err);
									return [];
								}
							},
							invalidate: () => {
								this.widgetRegistered = false;
								this.tui = undefined;
							},
						};
					},
					{ placement: "aboveEditor" },
				);
				this.widgetRegistered = true;
			} catch (err) {
				logAutoreviewError("widget.register_error", err);
			}
		} else {
			this.tui?.requestRender?.();
		}
	}

	dispose() {
		if (this.uiCtx?.setWidget) {
			try {
				this.uiCtx.setWidget(this.widgetKey, undefined);
			} catch (err) {
				logAutoreviewError("widget.dispose_error", err);
			}
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.jobs = [];
	}
}
