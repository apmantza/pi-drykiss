import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	saveConfig,
	setLensModel,
	setDefaultModel,
} from "./config.js";
import { selectModel } from "./model-selector.js";
import { resetPrompts } from "./prompt-builder.js";
import { LENS_NAMES } from "./types.js";

/**
 * Format a `modelScope` value for display. Handles the legacy single-hint
 * form, the new list form, and an unset value.
 */
function formatModelScope(scope: string | string[] | undefined): string {
	if (scope === undefined) return "(any free model)";
	if (Array.isArray(scope)) {
		const hints = scope.filter((s) => typeof s === "string" && s.trim());
		if (hints.length === 0) return "(any free model)";
		return hints.map((h) => `\`${h}\``).join(", ");
	}
	const trimmed = scope.trim();
	if (trimmed.length === 0) return "(any free model)";
	return `\`${trimmed}\``;
}

export async function handleConfigCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const subcommand = tokens[0]?.toLowerCase();

	if (!subcommand || subcommand === "show") {
		const config = await loadConfig();
		const lines = [
			"## DRYKISS Configuration",
			"",
			`**Default model:** ${config.defaultModel ?? "(not set — will prompt on first use)"}`,
			"",
			"**Per-lens models:**",
			...[...LENS_NAMES, "synthesis"].map(
				(lens) =>
					`  ${lens.padEnd(15)} ${config.lensModels?.[lens as keyof typeof config.lensModels] ?? "(inherits default)"}`,
			),
			"",
			`**Interactive prompts:** ${config.interactive !== false ? "enabled" : "disabled"}`,
			`**Confirm before run:** ${config.confirmBeforeRun !== false ? "enabled" : "disabled"}`,
			`**Context mode:** ${config.contextMode ?? "full"}`,
			`**Autoroute (free models):** ${config.autoroute === true ? "enabled" : "disabled"}`,
			`**Model scope:** ${formatModelScope(config.modelScope)}`,
			"",
			"Config file: `~/.pi/drykiss/config.json`",
			"Prompts dir: `~/.pi/drykiss/prompts/`",
			"",
			"Usage:",
			"  /drykiss-config set-default <model>",
			"  /drykiss-config set-lens <lens> <model>",
			"  /drykiss-config interactive <on|off>",
			"  /drykiss-config confirm <on|off>",
			"  /drykiss-config context-mode <diff|full>",
			"  /drykiss-config autoroute <on|off>",
			"  /drykiss-config model-scope <scope|clear>",
			"  /drykiss-config reset-prompts",
		];
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	if (subcommand === "set-default") {
		const model = tokens[1];
		if (!model) {
			if (ctx.hasUI) {
				const selected = await selectModel(
					ctx,
					"Set Default Model",
					"Choose the default model for all DRYKISS reviews:",
				);
				if (!selected) {
					ctx.ui.notify("No model selected.", "info");
					return;
				}
				await setDefaultModel(`${selected.provider}/${selected.id}`);
				ctx.ui.notify(
					`Set ${selected.name} as the default DRYKISS model.`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /drykiss-config set-default <model>", "warning");
			return;
		}
		await setDefaultModel(model);
		ctx.ui.notify(`Set ${model} as the default DRYKISS model.`, "info");
		return;
	}

	if (subcommand === "set-lens") {
		const lens = tokens[1];
		const model = tokens[2];
		if (!(LENS_NAMES as readonly string[]).includes(lens)) {
			ctx.ui.notify(
				`Invalid lens: ${lens}. Valid: ${LENS_NAMES.join(", ")}`,
				"error",
			);
			return;
		}
		if (!model) {
			ctx.ui.notify(
				`Usage: /drykiss-config set-lens ${lens} <model>`,
				"warning",
			);
			return;
		}
		await setLensModel(lens, model);
		ctx.ui.notify(`Set ${model} for ${lens} reviews.`, "info");
		return;
	}

	if (subcommand === "interactive") {
		const val = tokens[1]?.toLowerCase();
		const config = await loadConfig();
		if (val === "on" || val === "true") {
			config.interactive = true;
		} else if (val === "off" || val === "false") {
			config.interactive = false;
		} else {
			ctx.ui.notify("Usage: /drykiss-config interactive <on|off>", "warning");
			return;
		}
		await saveConfig(config);
		ctx.ui.notify(
			`Interactive model selection ${config.interactive ? "enabled" : "disabled"}.`,
			"info",
		);
		return;
	}

	if (subcommand === "confirm") {
		const val = tokens[1]?.toLowerCase();
		const config = await loadConfig();
		if (val === "on" || val === "true") {
			config.confirmBeforeRun = true;
		} else if (val === "off" || val === "false") {
			config.confirmBeforeRun = false;
		} else {
			ctx.ui.notify("Usage: /drykiss-config confirm <on|off>", "warning");
			return;
		}
		await saveConfig(config);
		ctx.ui.notify(
			`Pre-run confirmation ${config.confirmBeforeRun ? "enabled" : "disabled"}.`,
			"info",
		);
		return;
	}

	if (subcommand === "context-mode") {
		const val = tokens[1]?.toLowerCase();
		const config = await loadConfig();
		if (val === "diff" || val === "full") {
			config.contextMode = val;
		} else {
			ctx.ui.notify(
				"Usage: /drykiss-config context-mode <diff|full>",
				"warning",
			);
			return;
		}
		await saveConfig(config);
		ctx.ui.notify(`Context mode set to ${config.contextMode}.`, "info");
		return;
	}

	if (subcommand === "reset-prompts") {
		await resetPrompts();
		ctx.ui.notify(
			"Default prompt templates regenerated in `~/.pi/drykiss/prompts/`. Edit them to customize reviewer behavior.",
			"info",
		);
		return;
	}

	if (subcommand === "autoroute") {
		const val = tokens[1]?.toLowerCase();
		const config = await loadConfig();
		if (val === "on" || val === "true") {
			config.autoroute = true;
		} else if (val === "off" || val === "false") {
			config.autoroute = false;
		} else {
			ctx.ui.notify("Usage: /drykiss-config autoroute <on|off>", "warning");
			return;
		}
		await saveConfig(config);
		ctx.ui.notify(
			`Auto-routing to free models ${config.autoroute ? "enabled" : "disabled"}.`,
			"info",
		);
		return;
	}

	if (subcommand === "model-scope") {
		const config = await loadConfig();
		if (tokens.length <= 1) {
			ctx.ui.notify(
				"Usage: /drykiss-config model-scope <scope[,scope2,...]|clear>",
				"warning",
			);
			return;
		}
		// Accept either `model-scope a,b,c` or `model-scope a b c d`. Tokens
		// after the subcommand are joined and re-split on commas so both
		// forms produce the same parsed list.
		const joined = tokens.slice(1).join(" ");
		if (joined === "clear" || joined === "none" || joined === "") {
			delete config.modelScope;
			await saveConfig(config);
			ctx.ui.notify("Model scope cleared (any free model).", "info");
			return;
		}
		const hints = joined
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (hints.length === 0) {
			delete config.modelScope;
			await saveConfig(config);
			ctx.ui.notify("Model scope cleared (any free model).", "info");
			return;
		}
		if (hints.length === 1) {
			config.modelScope = hints[0];
		} else {
			config.modelScope = hints;
		}
		await saveConfig(config);
		ctx.ui.notify(
			`Model scope set to ${formatModelScope(config.modelScope)}.`,
			"info",
		);
		return;
	}

	ctx.ui.notify(
		`Unknown subcommand: ${subcommand}. Try /drykiss-config show.`,
		"error",
	);
}
