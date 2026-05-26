import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, setLensModel, setDefaultModel } from "./config.js";
import { selectModel } from "./model-selector.js";

export async function handleConfigCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0]?.toLowerCase();

  if (!subcommand || subcommand === "show") {
    const config = await loadConfig(ctx.cwd);
    const lines = [
      "## DRYKISS Configuration",
      "",
      `**Default model:** ${config.defaultModel ?? "(not set — will prompt on first use)"}`,
      "",
      "**Per-lens models:**",
      `  simplicity:     ${config.lensModels?.simplicity ?? "(inherits default)"}`,
      `  deduplication:  ${config.lensModels?.deduplication ?? "(inherits default)"}`,
      `  clarity:        ${config.lensModels?.clarity ?? "(inherits default)"}`,
      `  synthesis:      ${config.lensModels?.synthesis ?? "(inherits default)"}`,
      "",
      `**Interactive prompts:** ${config.interactive !== false ? "enabled" : "disabled"}`,
      `**Confirm before run:** ${config.confirmBeforeRun !== false ? "enabled" : "disabled"}`,
      "",
      "Config file: `.pi/drykiss/config.json`",
      "",
      "Usage:",
      "  /drykiss-config set-default <model>",
      "  /drykiss-config set-lens <lens> <model>",
      "  /drykiss-config interactive <on|off>",
      "  /drykiss-config confirm <on|off>",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (subcommand === "set-default") {
    const model = tokens[1];
    if (!model) {
      if (ctx.hasUI) {
        const selected = await selectModel(ctx, "Set Default Model", "Choose the default model for all DRYKISS reviews:");
        if (!selected) {
          ctx.ui.notify("No model selected.", "info");
          return;
        }
        await setDefaultModel(ctx.cwd, `${selected.provider}/${selected.id}`);
        ctx.ui.notify(`Set ${selected.name} as the default DRYKISS model.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /drykiss-config set-default <model>", "warning");
      return;
    }
    await setDefaultModel(ctx.cwd, model);
    ctx.ui.notify(`Set ${model} as the default DRYKISS model.`, "info");
    return;
  }

  if (subcommand === "set-lens") {
    const lens = tokens[1];
    const model = tokens[2];
    const validLenses = ["simplicity", "deduplication", "clarity", "synthesis"];
    if (!validLenses.includes(lens)) {
      ctx.ui.notify(`Invalid lens: ${lens}. Valid: ${validLenses.join(", ")}`, "error");
      return;
    }
    if (!model) {
      ctx.ui.notify(`Usage: /drykiss-config set-lens ${lens} <model>`, "warning");
      return;
    }
    await setLensModel(ctx.cwd, lens, model);
    ctx.ui.notify(`Set ${model} for ${lens} reviews.`, "info");
    return;
  }

  if (subcommand === "interactive") {
    const val = tokens[1]?.toLowerCase();
    const config = await loadConfig(ctx.cwd);
    if (val === "on" || val === "true") {
      config.interactive = true;
    } else if (val === "off" || val === "false") {
      config.interactive = false;
    } else {
      ctx.ui.notify("Usage: /drykiss-config interactive <on|off>", "warning");
      return;
    }
    await saveConfig(ctx.cwd, config);
    ctx.ui.notify(`Interactive model selection ${config.interactive ? "enabled" : "disabled"}.`, "info");
    return;
  }

  if (subcommand === "confirm") {
    const val = tokens[1]?.toLowerCase();
    const config = await loadConfig(ctx.cwd);
    if (val === "on" || val === "true") {
      config.confirmBeforeRun = true;
    } else if (val === "off" || val === "false") {
      config.confirmBeforeRun = false;
    } else {
      ctx.ui.notify("Usage: /drykiss-config confirm <on|off>", "warning");
      return;
    }
    await saveConfig(ctx.cwd, config);
    ctx.ui.notify(`Pre-run confirmation ${config.confirmBeforeRun ? "enabled" : "disabled"}.`, "info");
    return;
  }

  ctx.ui.notify(`Unknown subcommand: ${subcommand}. Try /drykiss-config show.`, "error");
}
