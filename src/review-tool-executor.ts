import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ReviewLens } from "./types.js";
import type { DrykissConfig } from "./config.js";
import type { ReviewJob, ReviewManager } from "./review-manager.js";
import type { ReviewResult } from "./review-result.js";
import type { ReviewScope } from "./review-scope.js";
import { LOG_PREFIX } from "./constants.js";

interface FlatReviewExecution {
	readonly ctx: ExtensionContext;
	readonly pi: ExtensionAPI;
	readonly manager: ReviewManager;
	readonly scope: ReviewScope;
	readonly config: DrykissConfig;
	readonly lenses: readonly ReviewLens[];
	readonly activeConstraints: string;
	readonly suppressions: DrykissConfig["suppressions"];
	readonly model?: string;
	readonly validate?: boolean;
	readonly signal?: AbortSignal;
	readonly onProgress?: (job: ReviewJob) => void;
}

/** Run the standard flat review and record its final result. */
export async function executeFlatReview(
	execution: FlatReviewExecution,
): Promise<ReviewResult> {
	const {
		ctx,
		pi,
		manager,
		scope,
		config,
		lenses,
		activeConstraints,
		suppressions,
		model,
		validate,
		signal,
		onProgress,
	} = execution;
	const result = await manager.runReview(
		ctx,
		pi,
		ctx.cwd,
		scope.files,
		scope.diffs,
		scope.contents,
		scope.projectIndex,
		{
			model,
			lenses: [...lenses],
			target: {
				mode: scope.mode,
				label: scope.label,
				metadata: scope.metadata,
			},
			severityOverrides: config.riskTargeting?.severity,
			ignorePatterns: config.riskTargeting?.ignore,
			suppressions,
			pathInstructions: config.review?.pathInstructions,
			activeConstraints,
			commands: config.commands,
			validate: validate ?? config.validate,
			qualityGateThreshold: config.qualityGate,
			findingBudget: config.review?.findingBudget,
			preparationErrors: scope.preparationErrors,
			onProgress,
		},
		signal,
	);
	try {
		manager.recordFinalResult(result);
	} catch (err) {
		console.warn("%s Failed to record final review result:", LOG_PREFIX, err);
	}
	return result;
}
