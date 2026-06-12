import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
	Box,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { loadConfig, type DrykissConfig } from "./config.js";
import {
	selectFreeModel,
	normalizeScopeHints,
	type ExcludedModel,
} from "./free-models.js";

const bgColor = (text: string): string => `\x1b[48;2;0;20;137m${text}\x1b[0m`;

function formatModelLabel(m: Model<Api>): string {
	const name = m.name && m.name !== m.id ? m.name : m.id;
	const providerLower = m.provider.toLowerCase();
	const nameLower = name.toLowerCase();
	// Strip provider prefix from name if already present to avoid duplication
	if (
		nameLower.startsWith(`${providerLower} `) ||
		nameLower.startsWith(`${providerLower}-`)
	) {
		return name.slice(m.provider.length + 1).trim();
	}
	return name;
}

function buildModelDescription(m: Model<Api>): string {
	const parts: string[] = [];
	if (m.id !== formatModelLabel(m)) parts.push(m.id);
	if (m.cost) {
		const { input, output } = m.cost;
		if (input === 0 && output === 0) parts.push("free");
		else parts.push(`$${input}/$${output}`);
	}
	return parts.join(" • ");
}

function calculatePopupWidth(items: SelectItem[], title: string): number {
	const prefixWidth = 2;
	const primaryGap = 2;
	const boxPadding = 2;
	const safetyMargin = 2;

	const maxLabelWidth = Math.max(
		...items.map((i) => visibleWidth(i.label ?? "")),
		visibleWidth(title),
	);

	const itemsWithDesc = items.filter((i) => i.description);
	const maxDescWidth =
		itemsWithDesc.length > 0
			? Math.max(...itemsWithDesc.map((i) => visibleWidth(i.description || "")))
			: 0;

	const contentWidth =
		maxDescWidth > 0
			? prefixWidth + Math.max(maxLabelWidth + primaryGap, 20) + maxDescWidth
			: prefixWidth + maxLabelWidth;

	return Math.min(contentWidth + boxPadding + safetyMargin, 80);
}

export async function selectModel(
	ctx: ExtensionContext,
	title: string,
	message: string,
): Promise<Model<Api> | undefined> {
	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	const items: SelectItem[] = available.map((m: any) => {
		const label = `[${m.provider}] ${formatModelLabel(m)}`;
		const description = buildModelDescription(m);
		return {
			value: `${m.provider}/${m.id}`,
			label,
			description,
		};
	});

	const optimalWidth = calculatePopupWidth(items, title);

	const maxHeight = Math.min(items.length + 8, 28);

	const selectedValue = await ctx.ui.custom<string | null>(
		(_tui: any, theme: any, _kb: any, done: any) => {
			const box = new Box(1, 1, bgColor);
			box.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

			// Handle multi-line message
			if (message) {
				for (const line of message.split("\n")) {
					box.addChild(new Text(theme.fg("dim", line), 1, 0));
				}
			}
			box.addChild(new Spacer(1));

			const selectList = new (SelectList as any)(
				items,
				Math.min(items.length, 15),
				{
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
				{ minPrimaryColumnWidth: 20 },
			);

			selectList.onSelect = (item: SelectItem) => done(item.value);
			selectList.onCancel = () => done(null);
			box.addChild(selectList);

			box.addChild(new Spacer(1));
			box.addChild(
				new Text(
					theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
					1,
					0,
				),
			);

			return {
				render: (w: number) => {
					const rendered = box.render(w);
					// Pad to fill the overlay area so Pi's UI doesn't show through
					const padLine = bgColor(" ".repeat(w));
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
				width: optimalWidth,
				maxHeight,
				anchor: "center",
			},
		},
	);

	if (!selectedValue) return undefined;

	const slashIndex = selectedValue.indexOf("/");
	if (slashIndex === -1) return undefined;

	return ctx.modelRegistry.find(
		selectedValue.slice(0, slashIndex),
		selectedValue.slice(slashIndex + 1),
	);
}

function matchesErrorPattern(err: unknown, keywords: string[]): boolean {
	let msg: string;
	if (err instanceof Error) {
		msg = err.message.toLowerCase();
	} else if (typeof err === "string") {
		msg = err.toLowerCase();
	} else if (typeof err === "object" && err !== null) {
		// Structured API error: {error: {type: "permission_error", message: "..."}, status: 403}
		msg = JSON.stringify(err).toLowerCase();
	} else {
		return false;
	}
	return keywords.some((kw) => msg.includes(kw));
}

export function isQuotaError(err: unknown): boolean {
	return matchesErrorPattern(err, [
		"quota",
		"rate limit",
		"ratelimit",
		"429",
		"402",
		"payment",
		"too many requests",
		"insufficient",
		"capacity",
		"overloaded",
		"exceeded",
		"budget",
		"credit",
		"inference",
		"failed to create stream",
		"request failed",
	]);
}

export function isAuthError(err: unknown): boolean {
	return matchesErrorPattern(err, [
		"api key",
		"authentication",
		"unauthorized",
		"401",
		"403",
		"permission",
		"forbidden",
	]);
}

/**
 * Detect server-side (5xx) errors from the model provider. These mean the
 * provider's gateway / upstream is unreachable for the current model, so
 * switching to a different model — ideally an autorouted free one — is a
 * reasonable recovery.
 */
export function isServerError(err: unknown): boolean {
	return matchesErrorPattern(err, [
		// Standard 5xx codes most providers use
		"500",
		"502",
		"503",
		"504",
		// Cloudflare / edge-layer equivalents
		"520",
		"521",
		"522",
		"523",
		"524",
		// Human-readable forms
		"internal server error",
		"bad gateway",
		"service unavailable",
		"gateway timeout",
		"terminated",
		"stream terminated",
		"connection terminated",
	]);
}

/**
 * Build the trailing scope note shown in the "Auto-routing to <model>" toast.
 * Handles both the single-hint and list forms of `config.modelScope`.
 */
function formatScopeNote(scope: string | string[] | undefined): string {
	const hints = normalizeScopeHints(scope);
	if (hints.length === 0) return "";
	if (hints.length === 1) return `, scope: ${hints[0]}`;
	return `, scope: [${hints.join(", ")}]`;
}

/** Check if an error is a model-level error (quota, auth, or server-side) that warrants model switching. */
export function isModelError(err: unknown): boolean {
	return isQuotaError(err) || isAuthError(err) || isServerError(err);
}

/**
 * Model selection with optional auto-routing to free models.
 *
 * Behavior:
 *   1. If `config.autoroute === true`, try to pick a free model:
 *      a. If `config.modelScope` is set, prefer a free model whose id/name
 *         matches the scope (substring match).
 *      b. Otherwise (or if no scope match), pick any free model.
 *      c. `excluded` (a model that just failed) is always skipped.
 *   2. If autorouting produced a model, return it. Notify the user so they
 *      know what was picked and why the popup didn't appear.
 *   3. If autorouting is disabled or produced no model, fall through to the
 *      standard interactive popup (`selectModel`).
 *
 * Use this in place of `selectModel` whenever a model is being picked and
 * the user has potentially configured auto-routing — the initial selection
 * in `resolveModelSmart`, the quota/auth retry in `callLLM`, and the
 * per-lens / synthesis retry in `ReviewManager`.
 */
export async function selectModelWithAutoroute(
	ctx: ExtensionContext,
	config: DrykissConfig,
	title: string,
	message: string,
	excluded?: ExcludedModel,
): Promise<Model<Api> | undefined> {
	if (config.autoroute === true) {
		const free = selectFreeModel(ctx, config.modelScope, excluded);
		if (free) {
			const scopeNote = formatScopeNote(config.modelScope);
			ctx.ui.notify(`Auto-routing to ${free.name} (free${scopeNote})`, "info");
			return free;
		}
	}

	// No autoroute, or no free model available: the popup fallback needs a UI.
	// In a headless context, there's nothing more we can do — return undefined
	// so the caller can decide how to handle the unrecoverable error.
	if (!ctx.hasUI) return undefined;

	return await selectModel(ctx, title, message);
}

/**
 * Attempt to select a different model when a model error occurs (quota/auth).
 *
 * Wraps selectModelWithAutoroute in a try/catch so that failures in the
 * autoroute plumbing (loadConfig error, ui.custom reject, etc.) surface as
 * a silent fallback to the caller — not an unhandled rejection. Returns
 * undefined if no model was selected or if autorouting failed.
 *
 * This is the shared helper for the repeated retry pattern in:
 *   - callLLM (llm.ts)
 *   - runLens (review-manager.ts)
 *   - runSynthesis (review-manager.ts)
 */
export async function selectModelOnError(
	ctx: ExtensionContext,
	failedModel: { provider: string; id: string },
	title: string,
	message: string,
): Promise<Model<Api> | undefined> {
	try {
		const config = await loadConfig();
		return await selectModelWithAutoroute(ctx, config, title, message, {
			provider: failedModel.provider,
			id: failedModel.id,
		});
	} catch {
		// Autoroute failed — return undefined so caller can decide how to handle
		return undefined;
	}
}
