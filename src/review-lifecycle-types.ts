import type {
	ExtensionContext,
	AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api, Usage } from "@earendil-works/pi-ai";
import type { ReviewLens, SynthesisResult } from "./types.js";

export type LensStatus = "queued" | "running" | "done" | "error";

export interface LensState {
	status: LensStatus;
	modelName: string;
	provider?: string;
	durationMs: number;
	errorMessage?: string;
	findingsCount: number;
	rawOutput: string;
	startedAt?: number;
	logPath?: string;
	session?: AgentSession;
	streamingText?: string;
}

/** Shared mutable review state used by lifecycle runners. */
export interface ReviewValidationIssue {
	readonly findingIndex: number;
	readonly reason: string;
	readonly finding?: unknown;
}

export interface ReviewJobState {
	id: string;
	files: string[];
	lenses: ReviewLens[];
	states: Map<ReviewLens, LensState>;
	synthesisStatus: "idle" | "running" | "done" | "error";
	synthesisResult?: SynthesisResult;
	synthesisStartedAt?: number;
	synthesisSession?: AgentSession;
	reviewPath?: string;
	overallStatus: "queued" | "running" | "done" | "error";
	startedAt: number;
	completedAt?: number;
}

export interface SubagentResult {
	lens: string;
	text: string;
	modelName: string;
	provider?: string;
	durationMs: number;
	usage?: Usage;
	errorMessage?: string;
	session?: AgentSession;
}

export interface LensExecutionTask {
	readonly jobId: string;
	readonly lens: ReviewLens;
	readonly model: Model<Api>;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly signal: AbortSignal;
	readonly onStreamUpdate: () => void;
}

export type RetryLensOnModelError = (
	ctx: ExtensionContext,
	failedModel: Model<Api>,
	failedSession: AgentSession | undefined,
	taskLabel: string,
	runFn: (model: Model<Api>) => Promise<SubagentResult>,
	options?: { error?: unknown; lens?: string },
) => Promise<SubagentResult | null>;
