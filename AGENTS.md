# pi-drykiss — Agent Context

A Pi extension that runs multi-lens code reviews (KISS, DRY, resilience, architecture, tests) through parallel reviewer subagents. Each lens is an isolated LLM call with a focused system prompt; findings are synthesized into a ranked, cross-validated report.

> **Hard constraint:** All prompt text MUST live in `.md` files. TypeScript modules MUST NOT contain prompt text as string literals. See `prompt-architecture.md` for the full rule. The `npm run check:no-prompt-literals` script enforces it in CI.

## Architecture

```
src/
  index.ts            # Extension entry point — registers the drykiss_autoreview tool + event handlers
  review-command.ts   # drykiss_autoreview tool handler + review orchestration (runDeepAutoreview)
  review-manager.ts   # Manages review jobs, parallel lens execution, synthesis
  subagent-runner.ts  # Spawns lens reviews as Pi agent sessions
  lens-runner.ts      # Executes individual lens reviews, retries, and output normalization
  synthesis-runner.ts # Executes synthesis, retries, persistence, and completion notification
  review-output.ts    # Formats structured review results for tool output
  deep-review-command.ts # Deep-review tool workflow and result mapping
  review-tool-executor.ts # Flat-review execution and final-result recording
  llm.ts              # LLM call helpers (callLens, callSynthesizer, withRetry)
  prompt-loader.ts    # Pure file-reading: reads .md files from user dir (with bundled fallback)
  prompt-composer.ts  # Composes a lens system prompt from shared fragments + per-lens body
  prompt-seed.ts      # Seeds bundled Markdown prompts into the user customization directory
  prompt-builder.ts   # Thin orchestrator: ties loader + composer together; builds review context
  mode-context.ts     # Resolves review posture (proposed vs audit) and loads mode-context-{proposed,audit}.md
  scout.ts            # Pre-flight scout stage: maps the project, reads docs, selects important files for full-codebase reviews
  logger.ts           # Fail-safe JSONL lifecycle logging to ~/.pi/drykiss/autoreview.log
  prompts/            # The bundled default prompt text — the source of truth (see prompt-architecture.md)
    _shared/          # iron-law, json-output, json-output-synthesis, json-output-scout, grounding-rules, grounding-rules-synthesis, active-constraints, mode-context-{proposed,audit}, validator, pass-system, focuses, risk-codes
    simplicity.md, deduplication.md, clarity.md, resilience.md, architecture.md, tests.md, security.md, docs.md, synthesis.md, scout.md
  model-selector.ts   # Resolves model hints, interactive selection, isModelError detection
  git-diff.ts         # Git diff parsing, file status detection, project index generation
  edit-tracker.ts     # Tracks file edits across turns via tool_execution_end events
  auto-inject.ts      # Builds the KISS/DRY checklist injected after editing turns
  config.ts           # Per-project config (.pi/drykiss/config.json) persistence
  free-models.ts      # Free-model detection (isFreeModel) and auto-routing (selectFreeModel)
  persist.ts          # Saves review results to .pi/drykiss/reviews/ and session transcripts to .pi/drykiss/sessions/
  types.ts            # Shared domain types (Finding, SynthesisResult, ReviewLens, etc.)

scripts/
  check-no-prompt-literals.ts   # CI guard: fails the build if prompt text leaks into .ts files
  check-no-prompt-literals.test.ts
```

## Key Design Principles

1. **Prompts live in `.md` files** — `src/prompts/<lens>.md` and `src/prompts/_shared/*.md` are the source of truth. The TypeScript code is pure orchestration. The CI check `npm run check:no-prompt-literals` catches regressions.
2. **Parallel lens reviews** — Each lens runs as an independent LLM call. No lens sees another's output until synthesis. This prevents groupthink and keeps context windows focused.
3. **Full-file context** — Reviewers see the complete file, not just the diff hunk, so they can spot existing helpers or patterns elsewhere in the file.
4. **Project-wide DRY** — The deduplication lens gets an index of all existing modules/exports across the codebase.
5. **Structured JSON output** — Each lens returns `{ findings: Finding[] }` with severity, confidence, line numbers, and suggestions. Synthesis deduplicates and ranks them.
6. **Auto-injection** — After any turn that edits files, a lightweight KISS/DRY checklist is prepended to the next system prompt (zero extra LLM calls).
7. **Model error retry** — When a subagent completes with a quota/auth/5xx/stream-termination error, `review-manager.ts` detects it via `isModelError()`, prompts the user to select a different model (or autoroutes), and retries the lens review automatically.
8. **Flat default review topology** — `/drykiss --all` should stay a flat parallel lens fan-out plus synthesis. Do not add nested subagents to every lens by default; use nested/child agents only for selective verification or a separate improve/advisor workflow.
9. **Failed lenses must be visible** — A review with a failed lens is incomplete. Synthesis prompts and final notifications should surface lens failures instead of silently approving based on the remaining lenses.
10. **Scout is a pre-flight stage, not a lens** — For full-codebase reviews, an optional scout stage maps the project (docs, file list, exports) and selects the most important files before the flat lens fan-out. It runs as a scope-preparation phase, not a parallel lens, preserving the flat topology. Scout failure falls back to the full file list (fail-open).

## Testing

- Uses **Vitest**. Run with `npm test`.
- Tests are co-located with source files (`*.test.ts`).
- Key test files:
  - `auto-injector.test.ts` — checklist injection logic
  - `git-diff.test.ts` — diff parsing edge cases
  - `prompt-builder.test.ts` — prompt composition (mocks the loader/composer layer)
  - `prompt-composer.test.ts` — lens/synthesis prompt assembly
  - `model-selector.test.ts` — model hint resolution and fallback
  - `review-command.test.ts` — drykiss_autoreview tool handler + deep review
  - `scripts/check-no-prompt-literals.test.ts` — CI guard tests
  - `index.test.ts` — extension registration smoke test

## Important Conventions

- **Pi extension entry point**: `index.ts` (declared in `package.json` under `pi.extensions`). Pi loads this via jiti, so TypeScript works without compilation.
- **Peer dependencies**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` are peer deps. Do not bundle them.
- **Config directory**: `.pi/drykiss/` (created per-project). Holds `config.json` and persisted review results.
- **Severity order**: `critical > high > medium > low > nit`
- **Severity action mapping**: Critical = must fix, High = should fix, Medium = worth fixing, Low = nice-to-have, Nit = optional
- **Confidence levels**: `confirmed` (seen by ≥2 lenses), `likely` (single lens, high severity), `suspect` (single lens, low severity)
- **Model hints**: Users can pass `--model=haiku` or `--model=sonnet`. `model-selector.ts` maps these to actual model IDs with a fallback chain.
- **Model error handling**: `isModelError()` in `model-selector.ts` detects quota/auth errors, 5xx provider errors, and stream termination strings such as `terminated`. `review-manager.ts` checks `result.errorMessage` after subagent completion and triggers model selection popup + retry if needed.
- **Auto-routing to free models**: When `autoroute: true` is set in `~/.pi/drykiss/config.json`, `selectModelWithAutoroute` in `model-selector.ts` consults `selectFreeModel` in `free-models.ts` (which uses an inlined copy of pi-free's `isFreeModel` logic) before falling through to the standard popup. The optional `modelScope` field narrows the choice to a substring of the model id/name. Auto-routing applies to initial selection (`resolveModelSmart`), the callLLM retry path, and the per-lens / synthesis retry paths in ReviewManager. The just-failed model is always passed as `excluded` to avoid infinite loops. `isModelError` covers quota, auth, 5xx server errors, and stream termination so transient gateway issues (504, 502, `terminated`, etc.) also trigger autorouting.
- **Subagent execution path**: Lens subagents intentionally call `session.agent.prompt(...)` rather than `session.prompt(...)`. This avoids session-level post-turn continuation hooks creating a secondary `Cannot continue from message role: assistant` error after a valid one-shot review has already completed.
- **Lens output normalization**: `ReviewManager` parses successful lens output with `lenientJsonParse`, accepts either a JSON array or `{ findings: [...] }`, then stores a normalized JSON array for synthesis. Keep this normalization in sync with the single-lens/tool parser in `review-command.ts`.
- **Session log links in the TUI widget**: When a lens subagent finishes, its session transcript is exported to `~/.pi/drykiss/sessions/<jobId>-<lens>.jsonl` via `saveSessionLog` in `persist.ts` (using `AgentSession.exportToJsonl`). The widget renders the basename as an OSC 8 hyperlink via `hyperlink()` from `@earendil-works/pi-tui`, with a `file://` URL built by `pathToFileURL`. In supporting terminals (Ghostty, Kitty, WezTerm, iTerm2, VSCode) the user can click to open the transcript; in others the escape codes are stripped, leaving a copy-pasteable basename. Only `done` / `error` lenses show the link — `running` and `queued` lenses have no transcript yet.
- **Prompt file resolution order**: env var `DRYKISS_PROMPTS_DIR` → `~/.pi/drykiss/prompts/` (user-customized) → bundled `src/prompts/` (via `new URL(..., import.meta.url)` and jiti).
- **Prompt injection / secret handling**: Shared grounding prompts instruct lenses to treat repository content as data, not instructions, and never reproduce secret values. If you add prompts or user-context text, preserve those safeguards and cite credential type + location only.
- **Architecture lens output**: The architecture lens must obey the same JSON-array output contract as every other lens. Do not ask it to append markdown/Mermaid blocks outside JSON; dependency-graph details belong in findings or the final synthesis `mermaidGraph` field.
- **Improve workflow direction**: If adding `/drykiss-improve`, implement it as an advisor/post-synthesis workflow (recon + prioritized findings + optional plans), not as another default lens. It may use hierarchical/nested subagents selectively for noisy verification, but default `/drykiss --all` should remain flat.

## When Modifying

- **Adding a new lens**:
  1. Drop a `.md` file at `src/prompts/<lens>.md`. The `default_prompts.ts` file no longer exists — `.md` is the only place to put prompt text.
  2. Update `ReviewLens` in `types.ts` and `LENS_DISPLAY_NAMES` in `constants.ts`.
  3. Add a command in `review-command.ts` and register it in `index.ts`.
- **Editing a prompt**: Edit the `.md` file under `src/prompts/`. The change ships with the next release. Users who have not customized the prompt will see the new content on first run after upgrade (the sentinel-versioned seed respects the bundled default).
- **Changing the synthesis logic**: Edit `llm.ts` (`callSynthesizer`) and `types.ts` (`SynthesisResult`).
- **Changing auto-injection behavior**: Edit `auto-inject.ts` and `edit-tracker.ts`.
- **Changing JSON parsing / normalization**: Update both the blocking review path (`review-manager.ts`) and single-lens/tool path (`review-command.ts`). Add tests for bracket-containing strings, markdown fences, trailing commas, object-shaped `{ findings: [...] }` output, invalid JSON, and non-array JSON.
- **Changing model-error detection**: Update `model-selector.test.ts` and, when it affects per-lens retry, `review-manager.test.ts`.
- **Keep tests updated**: Any change to prompt composition, diff parsing, JSON parsing, or model selection should have matching test coverage. The `check-no-prompt-literals` test must be updated if you change the heuristics.

## Build & CI

- Type check only: `npm run typecheck`
- CI guard for prompt text in `.ts` files: `npm run check:no-prompt-literals`
- Full check: `npm run check` (tests + typecheck + CI guard)
- CI runs on GitHub Actions (`.github/workflows/ci.yml`).
