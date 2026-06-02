# pi-drykiss — Agent Context

A Pi extension that runs multi-lens code reviews (KISS, DRY, resilience, architecture, tests) through parallel reviewer subagents. Each lens is an isolated LLM call with a focused system prompt; findings are synthesized into a ranked, cross-validated report.

## Architecture

```
src/
  index.ts            # Extension entry point — registers commands, tools, event handlers
  review-command.ts   # Command handlers (/drykiss, /drykiss-kiss, etc.) + review orchestration
  review-manager.ts   # Manages review jobs, parallel lens execution, synthesis
  subagent-runner.ts  # Spawns lens reviews as Pi agent sessions
  llm.ts              # LLM call helpers (callLens, callSynthesizer, withRetry)
  prompt-builder.ts   # Builds system prompts for each lens from .md templates
  model-selector.ts   # Resolves model hints, interactive selection, isModelError detection
  git-diff.ts         # Git diff parsing, file status detection, project index generation
  edit-tracker.ts     # Tracks file edits across turns via tool_execution_end events
  auto-injector.ts    # Injects KISS/DRY checklist into system prompt after editing turns
  config.ts           # Per-project config (.pi/drykiss/config.json) persistence
  config-command.ts   # /drykiss-config command handler
  free-models.ts      # Free-model detection (isFreeModel) and auto-routing (selectFreeModel)
  persist.ts          # Saves review results to .pi/drykiss/reviews/ and session transcripts to .pi/drykiss/sessions/
  types.ts            # Shared domain types (Finding, SynthesisResult, ReviewLens, etc.)
```

## Key Design Principles

1. **Parallel lens reviews** — Each lens runs as an independent LLM call. No lens sees another's output until synthesis. This prevents groupthink and keeps context windows focused.
2. **Full-file context** — Reviewers see the complete file, not just the diff hunk, so they can spot existing helpers or patterns elsewhere in the file.
3. **Project-wide DRY** — The deduplication lens gets an index of all existing modules/exports across the codebase.
4. **Structured JSON output** — Each lens returns `{ findings: Finding[] }` with severity, confidence, line numbers, and suggestions. Synthesis deduplicates and ranks them.
5. **Auto-injection** — After any turn that edits files, a lightweight KISS/DRY checklist is prepended to the next system prompt (zero extra LLM calls).
6. **Model error retry** — When a subagent completes with a quota/auth error, `review-manager.ts` detects it via `isModelError()`, prompts the user to select a different model, and retries the lens review automatically.

## Testing

- Uses **Vitest**. Run with `npm test`.
- Tests are co-located with source files (`*.test.ts`).
- Key test files:
  - `auto-injector.test.ts` — checklist injection logic
  - `git-diff.test.ts` — diff parsing edge cases
  - `prompt-builder.test.ts` — prompt template rendering
  - `model-selector.test.ts` — model hint resolution and fallback
  - `config-command.test.ts` — config persistence
  - `index.test.ts` — extension registration smoke test

## Important Conventions

- **Pi extension entry point**: `index.ts` (declared in `package.json` under `pi.extensions`). Pi loads this via jiti, so TypeScript works without compilation.
- **Peer dependencies**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` are peer deps. Do not bundle them.
- **Config directory**: `.pi/drykiss/` (created per-project). Holds `config.json` and persisted review results.
- **Severity order**: `critical > high > medium > low > nit`
- **Severity action mapping**: Critical = must fix, High = should fix, Medium = worth fixing, Low = nice-to-have, Nit = optional
- **Confidence levels**: `confirmed` (seen by ≥2 lenses), `likely` (single lens, high severity), `suspect` (single lens, low severity)
- **Model hints**: Users can pass `--model=haiku` or `--model=sonnet`. `model-selector.ts` maps these to actual model IDs with a fallback chain.
- **Model error handling**: `isModelError()` in `model-selector.ts` detects quota/auth errors. `review-manager.ts` checks `result.errorMessage` after subagent completion and triggers model selection popup + retry if needed.
- **Auto-routing to free models**: When `autoroute: true` is set in `~/.pi/drykiss/config.json`, `selectModelWithAutoroute` in `model-selector.ts` consults `selectFreeModel` in `free-models.ts` (which uses an inlined copy of pi-free's `isFreeModel` logic) before falling through to the standard popup. The optional `modelScope` field narrows the choice to a substring of the model id/name. Auto-routing applies to initial selection (`resolveModelSmart`), the callLLM retry path, and the per-lens / synthesis retry paths in ReviewManager. The just-failed model is always passed as `excluded` to avoid infinite loops. `isModelError` covers quota, auth, and 5xx server errors so transient gateway issues (504, 502, etc.) also trigger autorouting.
- **Session log links in the TUI widget**: When a lens subagent finishes, its session transcript is exported to `~/.pi/drykiss/sessions/<jobId>-<lens>.jsonl` via `saveSessionLog` in `persist.ts` (using `AgentSession.exportToJsonl`). The widget renders the basename as an OSC 8 hyperlink via `hyperlink()` from `@earendil-works/pi-tui`, with a `file://` URL built by `pathToFileURL`. In supporting terminals (Ghostty, Kitty, WezTerm, iTerm2, VSCode) the user can click to open the transcript; in others the escape codes are stripped, leaving a copy-pasteable basename. Only `done` / `error` lenses show the link — `running` and `queued` lenses have no transcript yet.

## When Modifying

- **Adding a new lens**: Update `ReviewLens` in `types.ts`, add a prompt builder in `prompt-builder.ts`, add a command in `review-command.ts`, and register it in `index.ts`.
- **Changing the synthesis logic**: Edit `llm.ts` (`callSynthesizer`) and `types.ts` (`SynthesisResult`).
- **Changing auto-injection behavior**: Edit `auto-injector.ts` and `edit-tracker.ts`.
- **Keep tests updated**: Any change to prompt rendering, diff parsing, or model selection should have matching test coverage.

## Build & CI

- Type check only: `npm run typecheck`
- Lint: `npm run lint`
- Full check: `npm run check` (tests + lint + typecheck)
- CI runs on GitHub Actions (`.github/workflows/ci.yml`) — tests, typecheck, and lint verification.
