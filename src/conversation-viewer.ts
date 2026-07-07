/**
 * Conversation viewer — overlay for inspecting DRYKISS lens review sessions.
 *
 * Displays each lens's conversation (system prompt, user prompt, assistant
 * response, tool calls) in a scrollable overlay. Closed with Escape / Enter / q.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReviewJob } from "./review-manager.js";
import { extractAssistantText, stripAnsi } from "./content-utils.js";

export class ConversationViewer implements Component {
	private scrollOffset = 0;
	private allLines: string[] = [];
	private viewportHeight = 24;

	constructor(
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (_result?: undefined) => void,
		private readonly job: ReviewJob,
	) {
		this.rebuildLines();
		this.viewportHeight = Math.max(10, (tui.terminal?.rows ?? 30) - 6);
	}

	private rebuildLines() {
		const lines: string[] = [];
		const { fg, bold } = this.theme;

		lines.push(bold(`DRYKISS Review ${this.job.id}`));
		lines.push(`Files: ${this.job.files.join(", ")}`);
		lines.push(
			`Status: ${this.job.overallStatus} · ${this.job.lenses.length} lenses`,
		);
		lines.push("─".repeat(60));

		for (const lens of this.job.lenses) {
			const state = this.job.states.get(lens);
			if (!state) {
				lines.push("");
				lines.push(bold(fg("accent", `┌─ ${lens.toUpperCase()} ─ (state unavailable)`)));
				lines.push(fg("accent", "└─"));
				continue;
			}
			lines.push("");
			lines.push(
				bold(
					fg(
						"accent",
						`┌─ ${lens.toUpperCase()} ─ @${state.modelName} ─ ${state.status}`,
					),
				),
			);
			if (state.session && Array.isArray(state.session.messages)) {
				for (const msg of state.session.messages) {
					if (msg.role === "user") {
						const text =
							typeof msg.content === "string"
								? msg.content
								: extractAssistantText(msg.content);
						for (const chunk of chunkLine(text, 180)) {
							lines.push(fg("dim", `│ [User]: ${chunk}`));
						}
					} else if (msg.role === "assistant") {
						const textParts: string[] = [];
						const toolCalls: string[] = [];
						if (typeof msg.content === "string") {
							textParts.push(msg.content);
						} else if (Array.isArray(msg.content)) {
							for (const c of msg.content) {
								if (c.type === "text" && c.text) textParts.push(c.text);
								else if (c.type === "toolCall")
									toolCalls.push(`Tool: ${c.name ?? "unknown"}`);
							}
						}
						if (textParts.length) {
							for (const chunk of chunkLine(textParts.join("\n"), 180)) {
								lines.push(fg("dim", `│ [Assistant]: ${chunk}`));
							}
						}
						for (const tc of toolCalls) {
							lines.push(fg("muted", `│ → ${tc}`));
						}
					} else if (msg.role === "toolResult") {
						const text =
							typeof msg.content === "string"
								? msg.content
								: extractAssistantText(msg.content);
						for (const chunk of chunkLine(text, 150)) {
							lines.push(fg("muted", `│ [Result (${msg.toolName})]: ${chunk}`));
						}
					}
				}
			} else {
				lines.push(fg("dim", "│ (session not available)"));
			}
			lines.push(fg("accent", "└─"));
		}

		if (this.job.synthesisResult) {
			lines.push("");
			lines.push(bold(fg("accent", "┌─ SYNTHESIS ─")));
			lines.push(fg("dim", `│ Verdict: ${this.job.synthesisResult.verdict}`));
			for (const chunk of chunkLine(this.job.synthesisResult.summary, 180)) {
				lines.push(fg("dim", `│ Summary: ${chunk}`));
			}
			lines.push(fg("accent", "└─"));
		}

		this.allLines = lines;
	}

	render(width: number): string[] {
		const visible = this.allLines.slice(
			this.scrollOffset,
			this.scrollOffset + this.viewportHeight,
		);
		while (visible.length < this.viewportHeight) visible.push("");
		return visible.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		this.rebuildLines();
		this.viewportHeight = Math.max(10, (this.tui.terminal?.rows ?? 30) - 6);
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, "q")
		) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollOffset = Math.max(
				0,
				Math.min(
					this.allLines.length - this.viewportHeight,
					this.scrollOffset + 1,
				),
			);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.max(
				0,
				Math.min(
					this.allLines.length - this.viewportHeight,
					this.scrollOffset + this.viewportHeight,
				),
			);
		} else if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.scrollOffset = Math.max(
				0,
				this.allLines.length - this.viewportHeight,
			);
		}
	}
}

/**
 * Chunk a long line into smaller pieces for display.
 */
export function chunkLine(text: string, max: number): string[] {
	const t = stripAnsi(text).replaceAll(/\n/g, " ");
	if (!t) return [];
	if (t.length <= max) return [t];
	const chunks: string[] = [];
	for (let i = 0; i < t.length; i += max) {
		chunks.push(t.slice(i, i + max));
	}
	return chunks;
}
