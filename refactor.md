# DRYKISS Refactor Assessment

## Goal

DRYKISS should support four review workflows as first-class agent-callable capabilities:

1. **Git diff reviews** — local unstaged/staged/branch/commit changes.
2. **Full codebase reviews** — broad scans over source files.
3. **PR reviews** — GitHub PR diff + file context.
4. **Autoreviews at `agent_end`** — closeout review after the agent edits code.

The likely end state is a high-level tool such as `drykiss_autoreview`, but we should not expose it until the underlying review scope, lifecycle, validation, and safety foundations are solid.

## Inspiration: OpenClaw autoreview

OpenClaw's autoreview skill is valuable less for its prompt text and more for its operational discipline:

- It has explicit review targets: `local`, `branch`, `commit`, and auto target selection.
- It builds a frozen change bundle before invoking the reviewer.
- It emits strict structured JSON with findings, overall correctness, explanation, and confidence.
- It validates output and filters out-of-scope findings.
- It has a clear exit contract: clean review exits successfully; actionable findings are nonzero.
- It supports optional panel reviews, parallel tests, heartbeats for long-running engines, and a smoke harness with malicious/benign fixtures.
- Its skill contract tells the agent to verify findings, reject speculative review noise, fix only scoped issues, rerun tests, and rerun review after review-triggered fixes.

DRYKISS can preserve its stronger multi-lens model while adopting this target discipline and closeout contract.

## Current DRYKISS foundations

### Strong foundations already present

- **Multi-lens review architecture**: `ReviewManager` runs independent lens sessions and synthesizes results.
- **Good lens coverage**: simplicity, deduplication, clarity, resilience, architecture, tests, and security.
- **Full-file context support**: changed files can be reviewed with complete file content, not just diff hunks.
- **Project index support**: deduplication and architecture lenses can see exported modules across the project.
- **Background job model**: reviews run as jobs with progress state, cancellation, cleanup, and UI notifications.
- **Model resilience**: model resolution, per-lens overrides, autorouting, and retry-on-model-error are implemented.
- **Persistence**: synthesized reviews and subagent session transcripts are saved.
- **PR support exists**: `github-pr.ts` can parse PR refs, fetch diffs, fetch full file contents, and validate PR file paths.
- **A programmatic tool exists**: `drykiss_review` lets the agent run a focused single-lens review on explicit files.
- **Some edit tracking exists**: `edit-tracker.ts` can track edited files per turn.

### Foundations that are incomplete or brittle

- **No unified review target abstraction**: command prep, PR prep, file prep, and tool prep are still command-oriented rather than a reusable `ReviewScope` layer.
- **The current tool is too narrow**: `drykiss_review` requires explicit files and one lens; it does not support local/staged/branch/commit/PR/full targets or multi-lens synthesis.
- **No blocking tool result for full reviews**: `ReviewManager.startReview()` starts a background job, but an agent-callable closeout tool needs an option to wait and return the final structured verdict.
- **No `agent_end` autoreview wiring**: the extension listens to `tool_execution_start` and `session_start`, but not `tool_execution_end`, `turn_end`, or `agent_end` for automatic review.
- **Edit tracker is not connected**: `createEditTracker()` is tested, but not instantiated or used in `index.ts`.
- **Tool-name tracking may be wrong for Pi built-ins**: `edit-tracker.ts` tracks `Write` and `Edit`, while Pi tool events likely use lowercase names such as `write` and `edit`.
- **Stale architecture notes**: `AGENTS.md` references `auto-injector.ts`, but that file is absent. Either the file was removed or the architecture documentation is stale.
- **Output validation is lenient**: lens outputs are parsed as arrays, but there is no OpenClaw-style strict schema validation for final tool results or in-scope finding filtering.
- **No review target verdict contract**: current synthesis returns `Approve | Request changes | Needs security review`, but tools/commands do not provide a clean/non-clean process contract similar to OpenClaw.
- **No long-running review heartbeat for agent callers**: background UI exists, but tool progress updates should explicitly stream target, lens status, elapsed time, and final result.
- **No autoreview loop guards**: an `agent_end` hook would need debounce, reentrancy prevention, max file limits, severity thresholds, and opt-in configuration before it is safe.
- **No calibration harness**: there is no malicious/benign fixture suite to measure whether security/quality prompts catch concrete bugs without overflagging safe code.

## Do we have strong enough foundations to expose a new high-level autoreview tool?

Not yet.

The core review engine is promising, but the public agent-facing tool would currently sit on uneven foundations. The biggest missing piece is not another prompt; it is a stable orchestration layer that can answer:

- What exact target is being reviewed?
- What files are in scope?
- What context was included?
- Did every requested lens complete?
- Are findings structurally valid and in-scope?
- Is the review clean or actionable?
- Can an agent safely call this at closeout without causing recursive review loops or runaway spend?

Until those are solved, exposing `drykiss_autoreview` risks giving agents a tool that looks authoritative but is hard to reason about.

## Recommended refactor sequence

### Phase 1 — Build a reusable review scope layer

Create a module such as `review-scope.ts` that owns target resolution and context gathering.

Suggested concepts:

```ts
type ReviewMode = "auto" | "local" | "staged" | "branch" | "commit" | "pr" | "full";

interface ReviewScopeRequest {
  mode: ReviewMode;
  files?: string[];
  base?: string;
  commit?: string;
  pr?: string;
  contextMode?: "diff" | "full";
  maxFiles?: number;
}

interface ReviewScope {
  mode: ReviewMode;
  label: string;
  files: ChangedFile[];
  diffs: Map<string, string>;
  contents?: Map<string, FileContent>;
  projectIndex?: ProjectIndexEntry[];
  metadata: Record<string, unknown>;
}
```

Move command and PR preparation onto this shared layer. Commands, tools, and autoreview hooks should all call the same target resolver.

### Phase 2 — Add strict result validation and in-scope filtering

Before exposing a high-level tool, add stricter validation around final findings:

- Required finding fields.
- Valid severity values.
- Safe relative file paths only.
- Finding file must be in reviewed scope unless explicitly marked as contextual.
- Optional line existence checks when full content is available.
- Stable final result shape with `clean`, `verdict`, counts, findings, and errors.

This does not need to be as rigid as OpenClaw's schema, but the final agent-facing result should be deterministic.

### Phase 3 — Add a blocking review runner API

`ReviewManager` should expose something like:

```ts
startReview(...): Promise<string>
waitForReview(jobId, signal?): Promise<ReviewJob>
runReview(...): Promise<ReviewResult>
```

The UI commands can keep background behavior. The tool can call the blocking runner and stream progress via `onUpdate`.

### Phase 4 — Replace/augment the narrow tool

Only after phases 1-3, add a new high-level tool:

```ts
drykiss_autoreview({
  mode: "auto" | "local" | "staged" | "branch" | "commit" | "pr" | "full",
  files?: string[],
  base?: string,
  commit?: string,
  pr?: string,
  lenses?: ReviewLens[] | "all",
  model?: string,
  contextMode?: "diff" | "full",
  wait?: boolean
})
```

The existing `drykiss_review` can remain as a focused single-lens tool, but its description should be updated to include all supported lenses, not just simplicity/deduplication/clarity.

### Phase 5 — Wire autoreview at `agent_end`

Add opt-in config first. Then wire:

- `tool_execution_end` to track `write`/`edit` results.
- `turn_end` to finalize the edited-file set.
- `agent_end` to trigger review if code changed.

Required safety controls:

- Disabled by default.
- Confirmation by default in UI sessions.
- Headless-safe behavior.
- Debounce/throttle.
- Max files/max diff size.
- Reentrancy guard so review-triggered messages do not trigger another immediate review.
- Skip if no source files changed.
- Skip if a review is already running for the same scope.

### Phase 6 — Add calibration tests/harness

Port the OpenClaw fixture idea:

- Malicious fixture: command injection, path traversal, privacy leak.
- Benign fixture: shell/filesystem/auth-adjacent code that is safe.
- Assert malicious fixture produces actionable security findings.
- Assert benign fixture does not produce critical/high false positives.

This can start as a manual smoke script, then become CI-friendly where possible.

## Near-term implementation priorities

1. **Fix stale foundation docs/code mismatch**: either restore `auto-injector.ts` or update `AGENTS.md`.
2. **Wire and fix edit tracking**: lowercase tool names, `tool_execution_end`, `turn_end`.
3. **Extract `review-scope.ts`**: one shared path for local, staged, branch, commit, PR, full, and explicit files.
4. **Add `ReviewManager.waitForReview()`**: needed for tool calls.
5. **Add final result validation/in-scope filtering**.
6. **Then expose `drykiss_autoreview`**.

## Progress from first foundation pass

Implemented after this assessment:

- Added `src/review-scope.ts` as the shared target-resolution layer for local, staged, branch, commit, PR, full-codebase, and explicit-file scopes.
- Moved command preparation onto `resolveReviewScope()` so slash commands now share the same foundation intended for future tools/hooks.
- Added `ReviewManager.waitForReview()` so future agent-facing tools can start a review and return a final blocking result instead of only a background job id.
- Wired edit tracking into `tool_execution_end` and `turn_end`.
- Fixed edit tracking to accept lowercase Pi tool names (`write`, `edit`) while preserving existing behavior.
- Wired the existing KISS/DRY auto-injection block through `before_agent_start` after editing turns.
- Expanded `drykiss_review` prompt metadata so the agent sees all supported focused lenses, not only KISS/DRY/clarity.
- Added `src/review-scope.test.ts` coverage for branch, PR, and commit scope resolution.
- Added `ReviewManager.waitForReview()` test coverage.
- Added `src/review-result.ts` with strict final finding validation, in-scope filtering, severity counts, errors, `clean`, `verdict`, and stable `ReviewResult` output.
- Added `ReviewManager.runReview()` as a start + wait + result-formatting API for future tools and hooks.
- Added `src/review-result.test.ts` coverage for validation, clean verdicts, count aggregation, and error collection.
- Exposed a conservative blocking `drykiss_autoreview` tool over the new foundations. It supports local/staged/branch/commit/PR/full/files scopes, lens subsets, context mode, model hints, max-file guardrails, progress start update, and stable `ReviewResult` details.
- Added tool-level tests for `drykiss_autoreview` result return and `maxFiles` guardrails.

Implemented after exposing the tool:

- Added opt-in autoreview configuration under `config.autoreview`.
- Added `/drykiss-config autoreview <on|off>`.
- Added `/drykiss-config autoreview-mode <local|staged|branch|full|files> [base]`.
- Added `/drykiss-config autoreview-confirm <on|off>`.
- Wired `agent_end` autoreview execution after write/edit tool activity.
- Added safety basics: disabled by default, confirmation by default in UI sessions, in-progress guard, edited-file tracking, `maxFiles` guard, and no auto-trigger when no code edit was observed.
- Autoreview results are sent as follow-up messages; if not clean, they trigger a follow-up turn so the agent can inspect/fix.
- Added persisted report paths to `ReviewJob` and `ReviewResult`; tool output now includes the report path when available.
- Added same-scope dedupe and configurable cooldown (`config.autoreview.cooldownMs`, default 60000ms) for automatic reviews.

Implemented after persisted paths/cooldown:

- Added richer progress streaming during blocking review waits. `ReviewManager.runReview()` / `waitForReview()` now accept progress callbacks, and `drykiss_autoreview` streams lens completion/running/synthesis status roughly once per second.

Implemented after progress streaming:

- Added calibration fixtures and assessment helpers in `src/calibration-fixtures.ts`.
- Added malicious fixture covering command injection, path traversal, and privacy leak signals.
- Added benign security-adjacent fixture covering safe filesystem paths, `execFile`, owner-gated password-adjacent state, and safe public user serialization.
- Added `buildCalibrationPrompt()` for agent-driven calibration runs through `drykiss_autoreview`.
- Added heuristic `assessCalibrationOutput()` for checking malicious/benign calibration outputs.
- Added fixture/assessment tests in `src/calibration-fixtures.test.ts`.

Remaining before enabling automatic `agent_end` autoreviews by default:

- Keep it disabled by default until real-world calibration proves false positives/spend are acceptable.
- Run the calibration fixtures against real models and record pass/fail observations before changing defaults.

## Bottom line

DRYKISS now has a strong enough foundation to expose a conservative agent-callable `drykiss_autoreview` tool. Automatic `agent_end` autoreviews should still stay opt-in until config, debounce, reentrancy, and spend guardrails are implemented.
