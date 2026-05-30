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

export function isQuotaError(err: unknown): boolean {
	let msg: string;
	if (err instanceof Error) {
		msg = err.message.toLowerCase();
	} else if (typeof err === "string") {
		msg = err.toLowerCase();
	} else {
		return false;
	}
	return (
		msg.includes("quota") ||
		msg.includes("rate limit") ||
		msg.includes("ratelimit") ||
		msg.includes("429") ||
		msg.includes("402") ||
		msg.includes("payment") ||
		msg.includes("too many requests") ||
		msg.includes("insufficient") ||
		msg.includes("capacity") ||
		msg.includes("overloaded") ||
		msg.includes("exceeded") ||
		msg.includes("budget") ||
		msg.includes("credit")
	);
}

export function isAuthError(err: unknown): boolean {
	let msg: string;
	if (err instanceof Error) {
		msg = err.message.toLowerCase();
	} else if (typeof err === "string") {
		msg = err.toLowerCase();
	} else {
		return false;
	}
	return (
		msg.includes("api key") ||
		msg.includes("authentication") ||
		msg.includes("unauthorized") ||
		msg.includes("401") ||
		msg.includes("403")
	);
}

/** Check if an error is a model-level error (quota or auth) that warrants model switching. */
export function isModelError(err: unknown): boolean {
	return isQuotaError(err) || isAuthError(err);
}
