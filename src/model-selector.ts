import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

export async function selectModel(
  ctx: ExtensionContext,
  title: string,
  message: string,
): Promise<Model<Api> | undefined> {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) return undefined;

  const choices = available.map((m) => `${m.provider}/${m.id} — ${m.name}`);
  const selected = await ctx.ui.select(`${title}: ${message}`, choices);
  if (!selected) return undefined;

  const idx = choices.indexOf(selected);
  return available[idx];
}

export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("ratelimit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("insufficient_quota") ||
    msg.includes("capacity") ||
    msg.includes("overloaded")
  );
}

export function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("api key") ||
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("403")
  );
}
