import { buildAutoInjectBlock } from "./prompt-builder.js";
import type { TurnEdits } from "./types.js";

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

export interface InjectionResult {
  systemPrompt: string;
}

export function buildKissDryInjectionBlock(edits: TurnEdits): string | null {
  if (edits.files.length === 0) return null;
  return buildAutoInjectBlock(edits);
}

export function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  edits: TurnEdits,
): InjectionResult | undefined {
  const block = buildKissDryInjectionBlock(edits);
  if (!block) return undefined;
  return { systemPrompt: event.systemPrompt + block };
}
