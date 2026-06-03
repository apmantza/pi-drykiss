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

/**
 * Helper for boolean toggle subcommands (interactive, confirm, autoroute).
 * Loads config, validates the value, mutates the config key, saves, and
 * notifies. All async operations are wrapped in try-catch for error handling.
 */
async function handleBooleanToggle(
	ctx: ExtensionCommandContext,
	tokens: string[],
	configKey: "interactive" | "confirmBeforeRun" | "autoroute",
	onLabel: string,
	offLabel: string,
): Promise<boolean> {
	const val = tokens[1]?.toLowerCase();
	try {
		const config = await loadConfig();
		if (val === "on" || val === "true") {
			config[configKey] = true;
		} else if (val === "off" || val === "false") {
			config[configKey] = false;
		} else {
			ctx.ui.notify(`Usage: /drykiss-config ${tokens[0]} <on|off>`, "warning");
			return false;
		}
		await saveConfig(config);
		ctx.ui.notify(`${config[configKey] ? onLabel : offLabel}.`, "info");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Failed to update ${configKey}: ${msg}`, "error");
	}
	return true;
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
		try {
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to set default model: ${msg}`, "error");
		}
		return;
	}

	if (subcommand === "set-lens") {
		try {
			const lens = tokens[1];
			const model = tokens[2];
			// Allow "synthesis" as a settable lens — it appears in `show` and is
			// resolved by getModelForLens in llm.ts, so users should be able to
			// configure it. LENS_NAMES excludes it (it's not a review lens).
			if (
				!(LENS_NAMES as readonly string[]).includes(lens) &&
				lens !== "synthesis"
			) {
				ctx.ui.notify(
					`Invalid lens: ${lens}. Valid: ${[...LENS_NAMES, "synthesis"].join(
						", ",
					)}`,
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to set lens model: ${msg}`, "error");
		}
		return;
	}

	if (subcommand === "interactive") {
		await handleBooleanToggle(
			ctx,
			tokens,
			"interactive",
			"Interactive model selection enabled",
			"Interactive model selection disabled",
		);
		return;
	}

	if (subcommand === "confirm") {
		await handleBooleanToggle(
			ctx,
			tokens,
			"confirmBeforeRun",
			"Pre-run confirmation enabled",
			"Pre-run confirmation disabled",
		);
		return;
	}

	if (subcommand === "context-mode") {
		try {
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to set context mode: ${msg}`, "error");
		}
		return;
	}

	if (subcommand === "reset-prompts") {
		try {
			await resetPrompts();
			ctx.ui.notify(
				"Default prompt templates regenerated in `~/.pi/drykiss/prompts/`. Edit them to customize reviewer behavior.",
				"info",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to reset prompts: ${msg}`, "error");
		}
		return;
	}

	if (subcommand === "autoroute") {
		await handleBooleanToggle(
			ctx,
			tokens,
			"autoroute",
			"Auto-routing to free models enabled",
			"Auto-routing to free models disabled",
		);
		return;
	}

	if (subcommand === "model-scope") {
		try {
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to set model scope: ${msg}`, "error");
		}
		return;
	}

	ctx.ui.notify(
		`Unknown subcommand: ${subcommand}. Try /drykiss-config show.`,
		"error",
	);
}
