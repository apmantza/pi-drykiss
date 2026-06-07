# DRYKISS — Refactor Plan

A concrete, sequenced implementation plan for the items in `inspiration.md`. Each work item lists scope, files touched, test additions, acceptance criteria, and an effort estimate. Items are ordered so that each step leaves the codebase in a green state (typecheck + tests pass) and is independently revertable.

> **Hard constraint (see `prompt-architecture.md`):** All prompt text MUST live in `.md` files. TypeScript modules MUST NOT contain prompt text as string literals. This constraint governs every work item below. The migration of the existing hardcoded prompts is **P0.4** and is the first work item that creates a `.md` file.

> **Reading order:** §1 is the high-level plan and ordering rationale. §2 is the per-item work breakdown. §3 is the test plan. §4 is the risk register. §5 is the deferred work (deliberately *not* in this plan).

## Conventions

- **Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[skip]` rejected
- **Effort:** S = <1 hour · M = 1–4 hours · L = 4–8 hours · XL = 1+ day
- **Risk:** L = low (easy to revert, isolated) · M = medium (touches shared types) · H = high (changes user-facing JSON contract)
- **Branch strategy:** one feature per branch, all branched from `main` of pi-drykiss. Squash-merge. No rebase-after-review.
- **Compatibility:** every step keeps `tsc --noEmit` clean, all 333 existing tests passing, and the lens-display-name lookup functional. No public JSON contract changes without a major version bump + migration in `persist.ts::loadReview`.

---

## §1. Phased plan

Five phases. Each phase has a clear "done" state.

### Phase 0 — Migrate prompts to `.md` and clean up (~1 day)

This phase establishes the foundational constraint: all prompt text moves from `.ts` files to `.md` files, the TypeScript prompt code becomes pure orchestration, and a CI check prevents regression. All other phases build on this.

- **[P0.1] Read `prompt-architecture.md` end-to-end.** This is non-negotiable before touching the code. The file defines the new layout, the loader API, the composer API, the seed strategy, the package bundling decision, and the CI check. Anyone implementing the migration must follow the same architecture decisions.

- **[P0.2] Create `src/prompts/_shared/` directory and write the 8 shared fragment `.md` files.** Content for each comes from the current `src/prompt-builder.ts` constants:
  - `_shared/iron-law.md` — the "Never suggest fixes before completing risk diagnosis" rule. New content; not currently in any TS file. Add it now per the Iron Law pattern from brooks-lint.
  - `_shared/json-output.md` — the current `JSON_OUTPUT_INSTRUCTIONS` constant (with the new `consequence`/`source`/`fixability` fields from #2).
  - `_shared/json-output-synthesis.md` — the current `SYNTHESIS_JSON_INSTRUCTIONS` constant.
  - `_shared/grounding-rules.md` — the current `REVIEW_GROUNDING_RULES` constant.
  - `_shared/grounding-rules-synthesis.md` — the current `SYNTHESIS_GROUNDING_RULES` constant.
  - `_shared/kiss-dry-checklist.md` — the current `KISS_DRY_CHECKLIST` constant.
  - `_shared/active-constraints.md` — new; the `## Active Constraints` block template for the disable/severity/ignore/focus injection. Body says "this section is populated at runtime from the project config" with a placeholder syntax like `{{active_constraints}}`.
  - `_shared/README.md` — what each file is for, in plain English.
  *Effort S · Risk L*

- **[P0.3] Create `src/prompts/<lens>.md` and `src/prompts/synthesis.md` for each of the 7 lenses + synthesis.** Content comes from the current `DEFAULT_LENS_PROMPTS` and `DEFAULT_SYNTHESIS_PROMPT` in `src/default_prompts.ts` and the inline copies in `src/prompt-builder.ts`. Reconcile any drift between the two copies (the synthesis prompt appears in both; the lens prompts only in `default_prompts.ts`).
  *Effort S · Risk M (drift reconciliation)*

- **[P0.4] Write `src/prompt-loader.ts`.** Pure file-reading functions. ~50 lines. See `prompt-architecture.md` §"The prompt-loader.ts API".

- **[P0.5] Write `src/prompt-composer.ts`.** Pure composition logic. ~100 lines. See `prompt-architecture.md` §"The prompt-composer.ts API".

- **[P0.6] Rewrite `src/prompt-builder.ts` as a thin orchestrator.** Delete all prompt text constants (`DEFAULT_LENS_PROMPTS`, `DEFAULT_SYNTHESIS_PROMPT`, `JSON_OUTPUT_INSTRUCTIONS`, `SYNTHESIS_JSON_INSTRUCTIONS`, `REVIEW_GROUNDING_RULES`, `SYNTHESIS_GROUNDING_RULES`, `KISS_DRY_CHECKLIST`). Delete `default_prompts.ts` entirely. Reduce `prompt-builder.ts` from ~790 lines to ~150 lines. Update `loadLensSystemPrompt`, `loadSynthesisSystemPrompt`, `buildReviewPrompts`, `buildSynthesisPrompt`, `buildFileContext`, `buildProjectIndexContext` to use the new loader/composer.
  *Effort M · Risk M*

- **[P0.7] Update `package.json::files` to bundle `src/prompts/`** (Option A from `prompt-architecture.md`):
  ```json
  {
    "files": ["dist/", "src/prompts/"]
  }
  ```
  Verify `npm pack` includes the `.md` files.
  *Effort S · Risk L*

- **[P0.8] Write `scripts/check-no-prompt-literals.ts`.** The CI check. See `prompt-architecture.md` §"The CI check". Add a `check:no-prompt-literals` npm script. Add to `npm run check`.
  *Effort M · Risk L*

- **[P0.9] Update tests.** `src/prompt-builder.test.ts` currently mocks `node:fs/promises::readFile` and asserts on the string content. Update the tests to:
  - Point the loader at a test fixtures directory (`src/prompt-builder.test-fixtures/`) containing minimal `.md` files
  - Assert on `loadPromptFile` / `composeLensPrompt` return values
  - Add a test that the `default_prompts.ts` file no longer exists (or doesn't contain `DEFAULT_LENS_PROMPTS`)
  - Add a test that all expected `.md` files exist and are non-empty
  - Add a test for the prompt-content compliance assertions (Iron Law text is present, JSON output format is present, severity labels are present)
  *Effort M · Risk M*

- **[P0.10] Update `src/config-command.ts::resetPrompts` and `src/prompt-builder.ts::ensureDefaultPrompts` to use the bundled `.md` files.** They currently iterate over `DEFAULT_LENS_PROMPTS`. Change to read the manifest of bundled `.md` files and copy them to `~/.pi/drykiss/prompts/`. Add a sentinel-based version check (from P0.2 of the previous version of the plan, now subsumed here).
  *Effort M · Risk M*

- **[P0.11] Delete `src/default_prompts.ts`.** The file is now redundant. The migration is complete.
  *Effort S · Risk L*

- **[P0.12] Document the new layout in `AGENTS.md`.** Update the "Architecture" section's file tree, the "Key Design Principles" section to mention the `.md` constraint, the "When Modifying" section to point at the new files, the "Add a new lens" instructions to say "drop a `.md` file in `src/prompts/`".
  *Effort S · Risk L*

**Phase 0 done when:** `npx tsc --noEmit` is clean, all 333 tests pass, `src/default_prompts.ts` is deleted, `src/prompts/` contains all 8 lens + synthesis `.md` files plus the 8 shared fragments, `src/prompt-builder.ts` is ~150 lines of orchestration, `npm run check` (which now includes `check:no-prompt-literals`) passes, and a deliberate attempt to add a hardcoded prompt to a `.ts` file fails the build.

### Phase 1 — Finish #2's contract and surface it everywhere (~1 day)

The Symptom → Source → Consequence → Remedy contract was added to the `Finding` type and the prompts. Now we need to enforce it in validation, surface it in the widget, and add tests so it can't silently regress.

- **[P1.1] Update `validateFinding` in `src/review-result.ts` to require `consequence` and `source`.** The current validator only checks `category`/`summary`/`detail`/`suggestion`. Extend the required-field loop. Match the prompt's language: `consequence` and `source` must be non-empty strings when present (allow `undefined` for backward compat with persisted reviews, but require non-empty for *new* findings produced by lens runs). *Effort S · Risk M*

- **[P1.2] Update `mapRawToFinding` in `src/types.ts` to default `consequence` and `source` to non-empty values when `raw` provides them, instead of `undefined`.** Current code uses `raw.consequence ? String(raw.consequence) : undefined`. Change to: always coerce to string, empty string when missing. Match what the validator expects. *Effort S · Risk M*

- **[P1.3] Add a `riskCode?: string` field to `Finding`.** brooks-lint's R1–R6 + T1–T6 + Cx risk codes are the natural unit for config targeting (`disable`, `severity`, `focus`, `suppress` in later phases). Each lens prompt should assign a default `riskCode` per finding category. For now: add the field and start collecting it; enforcement comes in Phase 2. *Effort S · Risk L*

- **[P1.4] Update `src/review-widget.ts` to render `consequence`, `source`, and `fixability`.** When rendering a finding, show:
  ```
  🔴 [KISS] Divergent Change — UserService.update_profile
     Symptom: ...detail...
     → Consequence: ...consequence...
     → Source: ...source...
     → Fix: quick-fix (1-line) — ...suggestion...
  ```
  Use a `formatFinding(finding, theme)` helper exported from `review-widget.ts` and reused in the CLI's final result print. *Effort M · Risk L*

- **[P1.5] Add tests in `src/types.test.ts` and `src/review-result.test.ts`:**
  - `mapRawToFinding` produces non-empty `consequence`/`source` when raw input provides them
  - `mapRawToFinding` produces `""` for missing `consequence`/`source` (not `undefined`)
  - `validateFinding` rejects a finding with empty `consequence`
  - `validateFinding` rejects a finding with empty `source`
  - `validateFinding` accepts a legacy persisted finding (undefined `consequence`/`source`) — backward compat
  - `riskCode` defaults to `undefined` for unknown codes
  *Effort M · Risk L*

- **[P1.6] Add a `formatFinding` test in `src/review-widget.test.ts`.** Snap the rendering output against a known fixture. *Effort S · Risk L*

**Phase 1 done when:** `validateFinding` requires the new fields, the widget renders them, all tests pass (333 + ~8 new), `npx tsc --noEmit` clean, a fresh `/drykiss` review run on a sample file produces a widget output that includes the consequence/source/fixability lines.

### Phase 2 — Config model: disable, severity, ignore, focus, risk codes (~1.5 days)

The brooks-lint config model is the most leverage. Implementing it unlocks the suppress mechanism (Phase 3) and the Mermaid graph (Phase 4).

- **[P2.1] Add `riskCodes: Record<string, RiskCodeDefinition>` to `src/prompts/_shared/risk-codes.md` (frontmatter) and a `RISK_CODES: Record<string, RiskCodeDefinition>` constant to `src/prompts/index.ts` (a TS barrel that re-exports the frontmatter from each `.md` file's `---` block).** Define the 12 brooks-lint codes (R1–R6, T1–T6) plus DRYKISS-specific extensions (`D1` for DRY, `K1` for KISS, `S1` for security, `A1` for architecture, `C1` for clarity, `R7` for resilience). Each code has `{ name, diagnosticQuestion, sources, severityGuide }`. The TS constant is metadata, not prompt text, so it does not violate the `.md`-only constraint. *Effort M · Risk L*

- **[P2.2] Extend `src/config.ts::DrykissConfig` with `disable`, `severity`, `ignore`, `focus` fields.** Type them strictly. `disable` and `severity` take risk codes; `ignore` takes glob patterns (reuse the glob matching logic from `git-diff.ts`); `focus` takes risk codes (cannot combine with `disable`). Add `loadConfig` validation in the same style as `brooks-lint.yaml` validation:
  - Unknown risk code → warn, skip
  - Both `disable` and `focus` non-empty → ignore both, warn
  - Invalid severity value → warn, skip
  - File missing or corrupt → defaults, with a warning emitted via `ctx.ui.notify` (only when an `ctx` is available)
  *Effort M · Risk M*

- **[P2.3] Add a `loadEffectiveConfig(): Promise<{ ...DrykissConfig, _warnings: string[] }>` helper in `src/config.ts`.** Returns the validated config plus a list of validation warnings the caller can display. Update `loadConfig` to call it and return just the config (backward compat). *Effort S · Risk M*

- **[P2.4] Apply `disable`/`focus`/`ignore` at the lens-prompt-construction step in `src/prompt-composer.ts`.** The composer reads `src/prompts/_shared/active-constraints.md` (which has `{{active_constraints}}` placeholders), substitutes the runtime values, and concatenates with the lens body. The `loadLensSystemPrompt` function in `src/prompt-builder.ts` reads the active config, builds the constraints string, and passes it to the composer. The `active-constraints.md` file itself contains only template syntax and the static instructions ("list your active constraints here in plain language"). The runtime substitution is just a string replace. *Effort M · Risk M*

- **[P2.5] Apply `severity` overrides post-parse in `src/review-result.ts::validateFindings`.** After the standard severity validation, run a `applySeverityOverrides(findings, config.severity)` step that downgrades/upgrades `finding.severity` for matching risk codes. *Effort S · Risk M*

- **[P2.6] Apply `ignore` at the post-synthesis step in `src/review-command.ts::handleDrykissCommand`.** After all lenses complete, filter out findings whose `file` matches a glob in `config.ignore`. Count dropped findings in the `ReviewResult` for visibility. *Effort S · Risk M*

- **[P2.7] Add a `MIGRATION_V1` shim.** Existing user configs have no `disable`/`severity`/`ignore`/`focus` fields. The shim is a no-op (missing fields = empty defaults) but documents the migration in `AGENTS.md`. *Effort S · Risk L*

- **[P2.8] Tests:**
  - `src/config.test.ts`: validation warnings for unknown codes, focus+disable conflict, invalid severity
  - `src/prompt-composer.test.ts` (new): composed prompt includes the active-constraints block when disable is set; absent when no config; substitutions handle multiple constraints
  - `src/prompt-composer.test.ts` (new): reading the bundled `.md` files via `bundledPromptsDir()` produces the expected content
  - `src/review-result.test.ts`: severity override downgrades a finding
  - `src/review-result.test.ts`: ignore filter drops matching findings
  *Effort M · Risk L*

**Phase 2 done when:** `disable`, `severity`, `ignore`, `focus` work end-to-end (config → prompt constraint → post-parse override → post-synthesis filter), config validation warnings surface in the widget, all tests pass.

### Phase 3 — Suppressions with expiry (~1 day)

This is the killer feature for repeat use. It requires a project-local config file (not just the global one) and a new `/drykiss-suppress` command.

- **[P3.1] Introduce per-project config at `.pi/drykiss/config.json` (project-local) layered on top of the global `~/.pi/drykiss/config.json`.** `loadEffectiveConfig` reads both, project-local wins. *Effort M · Risk M*

- **[P3.2] Add `suppressions: Suppression[]` to the per-project config.** A `Suppression` is `{ riskCode, pattern, reason, addedAt, expiresAt? }`. Use glob `pattern` (e.g., `src/legacy/**`). Add `validateSuppression` and `applySuppressions(findings, suppressions, now)` to `src/review-result.ts`. Suppressed findings get `severity: "nit"` and a `_suppressed: true` marker (omit from the Health Score, render under a collapsed "Suppressed" section). Expired suppressions are ignored and the finding resurfaces. *Effort M · Risk M*

- **[P3.3] Add `/drykiss-suppress` command in `src/config-command.ts` and `src/review-command.ts`.** Interactive flow: ask for risk code, glob pattern, reason, optional expiry (default 90 days). Append to `.pi/drykiss/config.json`. The command is purely additive — does not require a review run. *Effort M · Risk M*

- **[P3.4] Add `manage-suppression` (alias: `drykiss-unignore`) command to remove an existing suppression by ID or pattern.** *Effort S · Risk M*

- **[P3.5] Add suppression diagnostics to the review widget.** Show "N suppressed findings" line below the regular findings count. Click to expand and see the suppression reasons. *Effort M · Risk L*

- **[P3.6] Tests:**
  - `applySuppressions` with a matching entry sets `severity: "nit"` and `_suppressed: true`
  - Expired suppressions are ignored
  - Pattern matching handles `**`, `*`, `?` correctly
  - `drykiss-suppress` writes the config file idempotently
  *Effort M · Risk L*

**Phase 3 done when:** a user can run `/drykiss-suppress K1 "src/legacy/**" "Accepted complexity — rewrite planned"`, re-run the review, and the matching findings appear in a collapsed "Suppressed" section without contributing to the Health Score.

### Phase 4 — Health Score, history, Mermaid graph (~1.5 days)

- **[P4.1] Add `healthScore: number` and `scoreBreakdown: { critical: number, warning: number, suggestion: number }` to `SynthesisResult` in `src/types.ts`.** Compute in `parseSynthesis`. brooks-lint formula: `100 − 15·critical − 5·warning − 1·suggestion`, floor 0. *Effort S · Risk M*

- **[P4.2] Map DRYKISS's 5 severity levels to brooks-lint's 3 tiers for score computation:** `critical → critical`; `high, medium → warning`; `low, nit → suggestion`. Implement as `severityToBrooksTier(severity)` in `src/types.ts`. *Effort S · Risk L*

- **[P4.3] Persist Health Score history to `.pi/drykiss/history.json` after every successful review run.** Schema: `[{ date, mode, score, breakdown, scope, lensSubset }]`. Implement in `src/persist.ts::appendHistory`. *Effort M · Risk M*

- **[P4.4] Render trend delta in the widget when ≥1 prior record exists for the same mode.** "Trend: 85 → 82 (−3) over last 3 runs". *Effort S · Risk L*

- **[P4.5] Generate Mermaid `graph TD` from `ProjectIndexEntry[]` in the architecture lens output.** Insert at the top of the architecture lens's final report. Subgraphs per top-level directory; arrows show imports; colour-code nodes by max severity of findings in that file (red=critical, yellow=warning, green=clean). *Effort L · Risk M*

- **[P4.6] Surface a `Quality Gate: pass/fail` indicator in the widget.** Pass if `healthScore >= config.qualityGate` (default 70; configurable in `~/.pi/drykiss/config.json`). *Effort S · Risk L*

- **[P4.7] Tests:**
  - `computeHealthScore` floors at 0
  - `severityToBrooksTier` returns the right tier for all 5 levels
  - `appendHistory` is idempotent (no duplicate entries for the same run)
  - Mermaid generator produces valid syntax (use a snapshot test against a fixture)
  - Quality gate pass/fail logic
  *Effort M · Risk L*

**Phase 4 done when:** every review run shows a Health Score in the widget, history is persisted, trend delta appears after the second run, architecture lens produces a Mermaid graph, and a quality-gate pass/fail indicator is visible.

### Phase 5 — Modes and on-demand sections (~2 days)

The most invasive refactor. Done last so all the new types and config fields it depends on are stable.

- **[P5.1] (Already done in Phase 0)** Reorganise prompts into `_shared/` + per-lens `.md` files. The Iron Law, Report Template, Health Score, History, Auto-Scope rules are already in `src/prompts/_shared/`. Each lens has its own `.md` file. *Effort: done · Status: see Phase 0*

- **[P5.2] Add a `ReviewMode` type and `modes` config field in `DrykissConfig`.** A `ReviewMode` is a named workflow that selects a subset of lenses:
  ```ts
  type ReviewMode = "review" | "audit" | "debt" | "test" | "health" | "sweep" | "quick-test"
  ```
  Default mappings: `review` → R1–R6 analog (simplicity, clarity, resilience, architecture, tests, security) + DRY as `deduplication`; `audit` → architecture + DRY; `test` → tests; `health` → abbreviated all; `sweep` → all + auto-fix flag. *Effort L · Risk M*

- **[P5.3] Add mode-based commands:** `/drykiss-review`, `/drykiss-audit`, `/drykiss-debt`, `/drykiss-test`, `/drykiss-health`, `/drykiss-sweep`, `/drykiss-quick-test`. Each maps to a `ReviewMode` and runs the corresponding lens subset. *Effort M · Risk M*

- **[P5.4] On-demand sections via `.md` template fragments.** Add new shared fragment files in `src/prompts/_shared/` for the on-demand sections:
  - `_shared/remedy-mode.md` — the `--fix` content
  - `_shared/triage-mode.md` — the `--interactive` content
  - `_shared/incremental-history.md` — the `--since=<ref>` content
  The composer reads the base fragments plus whichever on-demand fragments are requested. The TS code is just `if (flags.fix) sections.push(await loadSharedFragment(source, "remedy-mode"))`. *Effort M · Risk M*

- **[P5.5] Mode-aware synthesis health-score weights.** Different modes weight deductions differently. E.g., `quick-test` mode: tests lens dominates. Implement as a `scoreWeightsByMode: Record<ReviewMode, { critical, warning, suggestion }>` in config, with brooks-lint's defaults baked in. *Effort M · Risk M*

- **[P5.6] `AGENTS.md` rewrite to document the new architecture.** Update the key design principles, the file tree, the conventions, the build & CI. *Effort S · Risk L*

- **[P5.7] Tests:**
  - `_shared/` directory contains all 11 shared fragments (the 8 from Phase 0 + 3 new on-demand ones)
  - Per-lens `.md` file composes with shared fragments to produce the expected prompt
  - Mode → lens subset mapping is complete
  - `composePrompt(base, flags)` returns the base + on-demand sections
  *Effort M · Risk L*

**Phase 5 done when:** the on-demand sections compose correctly from `.md` files (not from TS strings), mode-based commands work, `AGENTS.md` reflects the final layout, and the CI check `check:no-prompt-literals` still passes (catches any drift back to TS-embedded prompts).

### Phase 6 — Antirez additions (deferred, see §5)

These are not in the main plan. They are listed in §5 with rationale for why they're deferred.

---

## §2. Per-item work breakdown

For each item: scope, files touched, test additions, acceptance criteria, effort, risk.

### P0.1 — Read `prompt-architecture.md`

- **Scope:** Read the full architecture doc. No code changes. The document defines the file layout, the loader/composer APIs, the seed strategy, the package bundling decision, the CI check. This is the source of truth for the migration.
- **Files:** none
- **Tests:** none
- **Acceptance:** Author can articulate, in their own words, why `.md` files are the source of truth and what `prompt-loader.ts` does.
- **Effort:** S · **Risk:** L

### P0.2 — Create `src/prompts/_shared/` and the 8 shared fragments

- **Scope:** Write the 8 shared `.md` files. Content for the 5 existing fragments comes from the corresponding TS constants; the 3 new ones (`iron-law.md`, `active-constraints.md`, `README.md`) are written fresh per the architecture doc.
- **Files:** `src/prompts/_shared/iron-law.md`, `_shared/json-output.md`, `_shared/json-output-synthesis.md`, `_shared/grounding-rules.md`, `_shared/grounding-rules-synthesis.md`, `_shared/kiss-dry-checklist.md`, `_shared/active-constraints.md`, `_shared/README.md`
- **Tests:** A snapshot test loads each file and asserts non-empty content + a known substring (e.g., "Output findings as a single JSON array" in `json-output.md`).
- **Acceptance:** All 8 files exist, are non-empty, contain the required substrings.
- **Effort:** S · **Risk:** L

### P0.3 — Create the 8 per-lens `.md` files

- **Scope:** Write `simplicity.md`, `deduplication.md`, `clarity.md`, `resilience.md`, `architecture.md`, `tests.md`, `security.md`, `synthesis.md` at `src/prompts/<lens>.md`. Content comes from the current `DEFAULT_LENS_PROMPTS` and `DEFAULT_SYNTHESIS_PROMPT` in `src/default_prompts.ts` and the inline copies in `src/prompt-builder.ts`. Reconcile any drift between the two copies.
- **Files:** 8 new `.md` files
- **Tests:** A snapshot test loads each file and asserts non-empty content + a known substring (e.g., "Simplicity Auditor" in `simplicity.md`).
- **Acceptance:** All 8 files exist, are non-empty, match the current prompt text (no semantic changes during migration).
- **Effort:** S · **Risk:** M (drift reconciliation between `default_prompts.ts` and inline in `prompt-builder.ts`)

### P0.4 — Write `src/prompt-loader.ts`

- **Scope:** Pure file-reading functions. ~50 lines. Resolves the prompt source dir from env var → user dir → bundled defaults.
- **Files:** `src/prompt-loader.ts` (new), `src/prompt-loader.test.ts` (new)
- **Tests:** Env var override. User dir takes precedence. Bundled fallback works.
- **Acceptance:** All `loadPromptFile` and `loadSharedFragment` test cases pass.
- **Effort:** S · **Risk:** L

### P0.5 — Write `src/prompt-composer.ts`

- **Scope:** Pure composition logic. ~100 lines. Reads the lens `.md` file + the relevant shared fragments and concatenates. Active-constraints substitution uses a `{{active_constraints}}` placeholder.
- **Files:** `src/prompt-composer.ts` (new), `src/prompt-composer.test.ts` (new)
- **Tests:** Composed prompt contains all expected fragments. Active-constraints block is included only when provided. Order of sections matches the architecture doc.
- **Acceptance:** All composer tests pass.
- **Effort:** M · **Risk:** L

### P0.6 — Rewrite `src/prompt-builder.ts` as a thin orchestrator

- **Scope:** Delete all 7 prompt-text constants (`DEFAULT_LENS_PROMPTS`, `DEFAULT_SYNTHESIS_PROMPT`, `JSON_OUTPUT_INSTRUCTIONS`, `SYNTHESIS_JSON_INSTRUCTIONS`, `REVIEW_GROUNDING_RULES`, `SYNTHESIS_GROUNDING_RULES`, `KISS_DRY_CHECKLIST`). Delete `default_prompts.ts`. Reduce `prompt-builder.ts` from ~790 lines to ~150 lines. Update `loadLensSystemPrompt`, `loadSynthesisSystemPrompt`, `buildReviewPrompts`, `buildSynthesisPrompt`, `buildFileContext`, `buildProjectIndexContext` to use the new loader/composer.
- **Files:** `src/prompt-builder.ts` (rewrite), `src/default_prompts.ts` (delete), `src/prompt-builder.test.ts` (update mocks to point at fixture dir)
- **Tests:** All 23 existing tests pass after mock updates. New tests for the new `loadLensSystemPrompt` signature (takes optional `activeConstraints`).
- **Acceptance:** `git grep "DEFAULT_LENS_PROMPTS" src/` returns nothing. `git grep "JSON_OUTPUT_INSTRUCTIONS" src/` returns nothing. `wc -l src/prompt-builder.ts` shows <200 lines.
- **Effort:** M · **Risk:** M

### P0.7 — Bundle `src/prompts/` in `package.json::files`

- **Scope:** Add `src/prompts/` to the `files` array in `package.json`. Verify `npm pack` includes the `.md` files.
- **Files:** `package.json`
- **Tests:** None
- **Acceptance:** `npm pack --dry-run` lists `src/prompts/simplicity.md` and 7 other lens files + 8 shared fragments.
- **Effort:** S · **Risk:** L

### P0.8 — Write `scripts/check-no-prompt-literals.ts`

- **Scope:** The CI check. Scans every `src/*.ts` (excluding tests) for template literals >200 chars, double-quoted strings >200 chars, and identifiers matching `DEFAULT_*_PROMPT` or `*_PROMPT_BODY`. Exits non-zero with a clear error pointing at the offending file/line. Add a `check:no-prompt-literals` npm script. Add to `npm run check`.
- **Files:** `scripts/check-no-prompt-literals.ts` (new), `package.json` (new script), `src/review-command.ts` and `src/prompt-builder.ts` (whitelist for legitimate long strings like JSON examples, licence headers, etc.)
- **Tests:** A new test suite runs the check against a fixture directory and asserts exit codes.
- **Acceptance:** `npm run check:no-prompt-literals` passes on the post-Phase-0 codebase. Deliberately adding a hardcoded prompt to a `.ts` file fails the build.
- **Effort:** M · **Risk:** L

### P0.9 — Update tests for the new architecture

- **Scope:** `src/prompt-builder.test.ts` currently mocks `node:fs/promises::readFile` and asserts on string content. Update the tests to point the loader at a fixtures directory containing minimal `.md` files, assert on `loadPromptFile` / `composeLensPrompt` return values, add a test that the `default_prompts.ts` file no longer exists, add a test that all expected `.md` files exist and are non-empty, add a test for the prompt-content compliance assertions.
- **Files:** `src/prompt-builder.test.ts` (rewrite), `src/prompt-builder.test-fixtures/` (new)
- **Acceptance:** All 23 tests pass. New compliance tests pass.
- **Effort:** M · **Risk:** M

### P0.10 — Update `ensureDefaultPrompts` and `resetPrompts`

- **Scope:** Read the manifest of bundled `.md` files (from `bundledPromptsDir()`) and copy them to `~/.pi/drykiss/prompts/`. Add sentinel-based version check. Clean up old sentinels.
- **Files:** `src/prompt-builder.ts`, `src/config-command.ts`, `src/prompt-builder.test.ts`
- **Tests:** Sentinel present → no writes. Sentinel absent → seeds all prompts. Version mismatch → re-seeds.
- **Acceptance:** First session start: seeds 16 files + sentinel. Second session start: no writes. Bump `package.json` version: re-seeds.
- **Effort:** M · **Risk:** M

### P0.11 — Delete `src/default_prompts.ts`

- **Scope:** Remove the file. All imports of `DEFAULT_LENS_PROMPTS` / `DEFAULT_SYNTHESIS_PROMPT` from `./default_prompts.js` (none, after P0.6) are removed.
- **Files:** `src/default_prompts.ts` (delete)
- **Tests:** A test asserts the file doesn't exist.
- **Acceptance:** `git status` doesn't show `src/default_prompts.ts`. CI check passes.
- **Effort:** S · **Risk:** L

### P0.12 — Update `AGENTS.md`

- **Scope:** Update the "Architecture" file tree to include `src/prompts/`. Update "Key Design Principles" to mention the `.md` constraint. Update "When Modifying" to point at the new files. Update "Add a new lens" instructions to say "drop a `.md` file in `src/prompts/`".
- **Files:** `AGENTS.md`
- **Tests:** None
- **Acceptance:** A new contributor can find `src/prompts/<lens>.md` and know that's where to edit.
- **Effort:** S · **Risk:** L

### P1.1 — Update `validateFinding`

- **Scope:** Add `consequence` and `source` to the required-string-field check in `src/review-result.ts::validateFinding`. Match the validator's existing trim/empty check style.
- **Files:** `src/review-result.ts`, `src/review-result.test.ts`
- **Tests:** Empty `consequence` → issue. Empty `source` → issue. Non-empty both → passes.
- **Acceptance:** Validator rejects findings with empty `consequence` or `source`. Existing 6 tests still pass.
- **Effort:** S · **Risk:** M

### P1.2 — `mapRawToFinding` defaults

- **Scope:** Change `consequence: raw.consequence ? String(raw.consequence) : undefined` to always coerce to string.
- **Files:** `src/types.ts`, `src/types.test.ts`
- **Tests:** Missing `consequence` → `""`. Missing `source` → `""`. Present → coerced.
- **Acceptance:** All 19 types tests pass + 2 new ones.
- **Effort:** S · **Risk:** M

### P1.3 — `riskCode` field

- **Scope:** Add `readonly riskCode?: string` to `Finding`. Map in `mapRawToFinding`. No enforcement yet.
- **Files:** `src/types.ts`, `src/types.test.ts`
- **Tests:** `riskCode: "K1"` round-trips. Missing → `undefined`.
- **Acceptance:** TypeScript happy, all tests pass.
- **Effort:** S · **Risk:** L

### P1.4 — Widget rendering

- **Scope:** Add `formatFinding(finding, theme): string` to `src/review-widget.ts`. Render in the widget's done-lens summary. Optionally surface in the final review output via `formatReviewForDisplay` in `src/persist.ts`.
- **Files:** `src/review-widget.ts`, `src/review-widget.test.ts`, `src/persist.ts`
- **Tests:** Snapshot test against a fixed finding. Empty `consequence`/`source` don't render their lines.
- **Acceptance:** Widget output includes the consequence/source/fixability lines when present.
- **Effort:** M · **Risk:** L

### P1.5 + P1.6 — Tests

- **Scope:** Add the test cases listed in Phase 1.
- **Files:** `src/types.test.ts`, `src/review-result.test.ts`, `src/review-widget.test.ts`
- **Acceptance:** `npx vitest run` → 333 + ~8 new = ~341 tests passing.
- **Effort:** M · **Risk:** L

### P2.1 — Risk code definitions in `src/prompts/_shared/risk-codes.md` (frontmatter) and a TS barrel

- **Scope:** Add `src/prompts/_shared/risk-codes.md` with YAML frontmatter containing the risk code definitions. Add `src/prompts/risk-codes.ts` (a TS barrel, *not* containing prompt text) that reads the frontmatter via a simple `gray-matter`-style parser or a hand-rolled `---`-block parser and exports `RISK_CODES: Record<string, RiskCodeDefinition>`. Define the 12 brooks-lint codes (R1–R6, T1–T6) plus DRYKISS-specific extensions (K1, D1, A1, S1, C1, R7). Each code has `{ name, diagnosticQuestion, sources, severityGuide }`. The barrel file is metadata, not prompt text, so it does not violate the `.md`-only constraint. The CI check `check:no-prompt-literals` should whitelist `risk-codes.ts` from the identifier-name check (but not from the long-string check, to ensure the file doesn't accidentally grow a prompt body).
- **Files:** `src/prompts/_shared/risk-codes.md` (new), `src/prompts/risk-codes.ts` (new), `src/prompts/risk-codes.test.ts` (new)
- **Tests:** `RISK_CODES.K1.name` round-trips from the frontmatter. Unknown code is `undefined`.
- **Acceptance:** Codes are importable from `src/prompts/risk-codes.ts`. The `.md` file is the source of truth; the `.ts` file is a typed accessor.
- **Effort:** M · **Risk:** L

### P2.2 — Extended config

- **Scope:** Add `disable`, `severity`, `ignore`, `focus` to `DrykissConfig`. Add `loadConfig` validation.
- **Files:** `src/config.ts`, `src/config.test.ts`
- **Tests:** Unknown code → warning. `focus + disable` conflict → ignored. Invalid severity → warning. Corrupt JSON → defaults + warning.
- **Acceptance:** Validation surface is clear. Configs without the new fields still load with defaults.
- **Effort:** M · **Risk:** M

### P2.3 — `loadEffectiveConfig`

- **Scope:** New helper that returns `{ config, warnings }`. `loadConfig` calls it and returns just the config.
- **Files:** `src/config.ts`, `src/config.test.ts`
- **Tests:** Warnings are non-empty when validation fails; empty when no issues.
- **Acceptance:** Backward-compat preserved.
- **Effort:** S · **Risk:** M

### P2.4 — Active Constraints block via `.md` template fragment

- **Scope:** The block is implemented in `src/prompt-composer.ts` (created in P0.5). The composer reads `src/prompts/_shared/active-constraints.md`, substitutes the `{{active_constraints}}` placeholder with the runtime-generated plain-language constraint list, and inserts the section into the final prompt. `loadLensSystemPrompt` in `src/prompt-builder.ts` reads the effective config, builds the constraint string, and passes it to the composer. *Effort M · Risk M*
- **Files:** `src/prompt-composer.ts` (modify), `src/prompt-builder.ts` (modify), `src/prompt-composer.test.ts` (new)
- **Tests:** Composed prompt includes the active-constraints block when disable/focus/ignore is set; absent otherwise. Substitutions handle multiple constraints. The block is sourced from the `.md` file, not a TS string.
- **Acceptance:** Lens prompt self-restricts based on project config. `git grep "active constraints" src/*.ts` returns nothing (all block text lives in `.md`).

### P2.5 — Severity override

- **Scope:** `applySeverityOverrides(findings, severityMap)` in `src/review-result.ts`. Called from `validateFindings`.
- **Files:** `src/review-result.ts`, `src/review-result.test.ts`
- **Tests:** `severity: { K1: "low" }` downgrades K1 findings. Unknown code is ignored.
- **Acceptance:** Existing 6 tests pass + 2 new.
- **Effort:** S · **Risk:** M

### P2.6 — Ignore filter

- **Scope:** `applyIgnoreFilter(findings, ignorePatterns)` in `src/review-result.ts` or `src/review-command.ts`. Use `picomatch` or a hand-rolled glob matcher.
- **Files:** `src/review-result.ts` (or new `src/glob-utils.ts`), `src/review-result.test.ts`
- **Tests:** `**/*.test.ts` drops test files. `src/legacy/**` drops nested files. No patterns → no-op.
- **Acceptance:** Filtered findings are dropped from the result and counted in a `droppedByIgnore` field.
- **Effort:** S · **Risk:** M

### P2.7 + P2.8 — Migration shim + tests

- **Scope:** Document the migration in `AGENTS.md`. Add the tests listed in Phase 2.
- **Files:** `AGENTS.md`, `src/config.test.ts`, `src/prompt-composer.test.ts`, `src/review-result.test.ts`
- **Acceptance:** Old configs (no new fields) work without warnings. New fields validate correctly.
- **Effort:** S · **Risk:** L

### P3.1 — Per-project config layer

- **Scope:** `loadEffectiveConfig` reads both `~/.pi/drykiss/config.json` and `.pi/drykiss/config.json` (project-local). Project-local wins on conflict. Add `getProjectConfigPath(cwd)` to `src/constants.ts`.
- **Files:** `src/config.ts`, `src/constants.ts`, `src/config.test.ts`
- **Tests:** Project config takes precedence. Project-only fields are loaded. Global-only fields are kept.
- **Acceptance:** Per-project overrides work end-to-end.
- **Effort:** M · **Risk:** M

### P3.2 — `suppressions` field

- **Scope:** Add `suppressions: Suppression[]` to per-project config. Implement `applySuppressions` and `validateSuppression`. Suppressed findings get `severity: "nit"` and a `_suppressed: true` marker.
- **Files:** `src/config.ts`, `src/review-result.ts`, `src/review-result.test.ts`
- **Tests:** Matching entry → suppressed. Expired → not suppressed. No match → unchanged.
- **Acceptance:** Suppressions work for both risk-code match and glob pattern match.
- **Effort:** M · **Risk:** M

### P3.3 — `/drykiss-suppress` command

- **Scope:** Interactive command. Asks for risk code, pattern, reason, optional expiry. Appends to `.pi/drykiss/config.json`. Idempotent.
- **Files:** `src/config-command.ts`, `src/review-command.ts` (re-export command), `src/index.ts` (register)
- **Tests:** Suppression is written. Re-running with same args is idempotent.
- **Acceptance:** `/drykiss-suppress K1 "src/legacy/**" "Rewrite planned" 2026-09-01` writes the entry.
- **Effort:** M · **Risk:** M

### P3.4 + P3.5 + P3.6 — Suppression management + widget

- **Scope:** `/drykiss-unignore` command. Widget shows collapsed "Suppressed" section.
- **Files:** `src/config-command.ts`, `src/review-widget.ts`, `src/review-widget.test.ts`
- **Acceptance:** User can list, add, remove suppressions. Widget shows them.
- **Effort:** M · **Risk:** M

### P4.1 + P4.2 — Health Score

- **Scope:** Add `healthScore` and `scoreBreakdown` to `SynthesisResult`. Compute via `computeHealthScore(findings)` in `src/types.ts`. Map DRYKISS 5 levels → brooks-lint 3 tiers.
- **Files:** `src/types.ts`, `src/llm.ts` (synthesis prompt may need to mention the score), `src/types.test.ts`
- **Tests:** Score floors at 0. Mapping is correct for all 5 severities.
- **Acceptance:** Every review run produces a Health Score in `[0, 100]`.
- **Effort:** S · **Risk:** M

### P4.3 + P4.4 — History + trend

- **Scope:** `appendHistory` in `src/persist.ts`. Render trend delta in widget when ≥1 prior record.
- **Files:** `src/persist.ts`, `src/review-widget.ts`, `src/persist.test.ts`
- **Tests:** Append is idempotent. Trend delta is correct for the last 3 runs.
- **Acceptance:** Second run shows the trend.
- **Effort:** M · **Risk:** M

### P4.5 — Mermaid graph

- **Scope:** `generateMermaidGraph(projectIndex, findingsByFile): string` in `src/mermaid-utils.ts` (new file). Architecture lens inserts the graph at the top of its output.
- **Files:** `src/mermaid-utils.ts`, `src/prompt-builder.ts`, `src/mermaid-utils.test.ts`
- **Tests:** Snapshot test against a fixture project index. Empty index returns empty string.
- **Acceptance:** Architecture lens report includes a valid Mermaid graph.
- **Effort:** L · **Risk:** M

### P4.6 + P4.7 — Quality gate + tests

- **Scope:** `qualityGate: number` in config (default 70). Widget shows pass/fail. Tests for the gate logic.
- **Files:** `src/config.ts`, `src/review-widget.ts`, `src/config.test.ts`
- **Acceptance:** Score below gate shows "FAIL" badge.
- **Effort:** S · **Risk:** L

### P5.1 — Done in Phase 0 (see P0.2–P0.6)

- **Scope:** The shared-fragment + per-lens `.md` layout is established in Phase 0, not Phase 5. P5.1 is therefore a no-op reference. Confirm by reading the Phase 0 deliverables: `src/prompts/_shared/` has 8 fragments, `src/prompts/<lens>.md` exists for all 7 lenses + synthesis, and `src/prompt-composer.ts` composes them. *No code changes in Phase 5.*
- **Files:** none
- **Acceptance:** Phase 0 done-when criteria all hold.
- **Effort:** — · **Risk:** —

### P5.2 — `ReviewMode` type

- **Scope:** Add `ReviewMode` to `src/types.ts`. Default mappings in `src/constants.ts::MODE_LENS_MAP`.
- **Files:** `src/types.ts`, `src/constants.ts`
- **Tests:** Every mode has a non-empty lens subset.
- **Acceptance:** TypeScript catches typos in mode names.
- **Effort:** M · **Risk:** M

### P5.3 — Mode-based commands

- **Scope:** Add command handlers in `src/review-command.ts`. Register in `src/index.ts`.
- **Files:** `src/review-command.ts`, `src/index.ts`
- **Acceptance:** All seven mode commands work.
- **Effort:** M · **Risk:** M

### P5.4 — On-demand sections

- **Scope:** `composePrompt(base, flags)` in `src/prompt-builder.ts`. Flags: `fix`, `interactive`, `since`.
- **Files:** `src/prompt-builder.ts`, `src/prompt-builder.test.ts`
- **Tests:** `--fix` adds the Remedy Mode section. `--interactive` adds Triage. `--since` adds incremental history.
- **Acceptance:** Prompt is composed correctly.
- **Effort:** M · **Risk:** M

### P5.5 — Mode-aware weights

- **Scope:** `scoreWeightsByMode` in `DrykissConfig` with brooks-lint defaults. `computeHealthScore` accepts a mode and uses the right weights.
- **Files:** `src/types.ts`, `src/config.ts`
- **Acceptance:** Different modes produce different scores.
- **Effort:** M · **Risk:** M

### P5.6 + P5.7 — `AGENTS.md` rewrite + tests

- **Scope:** Document the new architecture. Add tests for mode/subset mapping, prompt composition.
- **Files:** `AGENTS.md`, `src/prompt-builder.test.ts`, `src/types.test.ts`
- **Acceptance:** AGENTS.md reflects the new layout. New tests pass.
- **Effort:** S · **Risk:** L

---

## §3. Test plan

### Coverage targets

- **Types:** `src/types.test.ts` covers `mapRawToFinding`, `parseFindingsArray`, `parseSynthesis`, `createFallbackSynthesis`, `severityToBrooksTier`, `computeHealthScore`. Target: 30 tests.
- **Config:** `src/config.test.ts` covers `loadConfig`, `loadEffectiveConfig`, `validateConfig`, validation warnings, per-project layering. Target: 25 tests.
- **Prompt builder:** `src/prompt-builder.test.ts` covers all 7 lens prompts, synthesis prompt, `composePrompt`, `loadPromptBody`, `ensureDefaultPrompts`, `resetPrompts`, sentinel logic, active-constraints block. Target: 35 tests.
- **Review result:** `src/review-result.test.ts` covers `validateFinding` (all field checks, all severity values, all `riskCode` overrides), `applySeverityOverrides`, `applyIgnoreFilter`, `applySuppressions`, `countFindings`, `buildReviewResult`. Target: 20 tests.
- **Widget:** `src/review-widget.test.ts` covers `formatFinding`, the rendered widget output, suppressed section, trend delta. Target: 15 tests.
- **Mermaid:** `src/mermaid-utils.test.ts` (new) covers the generator with snapshot tests. Target: 5 tests.
- **Suppress command:** `src/config-command.test.ts` covers `/drykiss-suppress` write/idempotency, `/drykiss-unignore` removal, expiry validation. Target: 10 tests (existing 26 + 10 new).
- **Existing tests preserved:** review-command (10), review-manager (10), model-selector (37), free-models (37), review-scope (?, ~10), llm (25), index (20), persist (?), git-diff (?), conversation-viewer (?), github-pr (?), json-utils (?), calibration-fixtures (?).

### Test runs per phase

- After every work item: `npx vitest run` (all tests, expect new tests to pass)
- Before commit: `npx tsc --noEmit` + `npx vitest run`
- CI runs: `npm run check` (tests + typecheck + lint) — note lint is currently broken due to missing `eslint.config.js`; fix that early in Phase 0

### Edge cases to test specifically

- Empty review (no findings): Health Score = 100
- All-critical review: Health Score = max(0, 100 − 15·N) → floors at 0
- Expired suppression resurfaces
- Suppression with `**` glob matches nested files
- `disable` and `focus` both non-empty → ignored, warning emitted
- `severity: { K1: "low" }` downgrades K1 findings but not other lenses' findings
- `ignore: ["**/*.test.ts"]` drops test files only
- Per-project config takes precedence over global
- Sentinel-based seed: present → no writes, absent → all writes
- Mermaid generator with empty project index returns empty string
- Mermaid generator with circular import renders the edge as a back-arrow
- `riskCode` round-trips through `mapRawToFinding` → `validateFinding` → `applySeverityOverrides` → widget

---

## §4. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Validation strictness breaks existing persisted reviews** | M | M | P1.1's `validateFinding` accepts legacy `undefined` `consequence`/`source`; only rejects *new* findings. Add a `MIGRATION_V1` step that re-coerces legacy fields on load. |
| **Per-project config conflicts with global in surprising ways** | M | M | Document precedence clearly. Layer is "project wins on conflict; missing fields inherit from global". |
| **Mermaid generator produces invalid syntax** | M | L | Snapshot test against a known fixture. Wrap in a try/catch with a fallback to plain text. |
| **Suppression expiry is computed in user's local time vs UTC** | L | L | Always store `expiresAt` as ISO 8601 UTC. Compare against `Date.now()`. |
| **Phase 5 (modes) breaks backward compat with existing `/drykiss-*` commands** | M | H | Keep all existing commands. New mode commands are additions. Old commands still work via direct lens mapping. |
| **`tsc --noEmit` drift across phases** | M | M | Run `npx tsc --noEmit` after every work item. Add to pre-commit hook. |
| **Linter errors from biotype widening** | M | L | Don't add new deps in Phase 0–2. Only add `picomatch` in Phase 3 if needed (hand-roll a glob matcher if not). |
| **Auto-injection (`auto-injector.ts`) drifts from new prompt structure** | L | M | Update `auto-injector.ts` to read from the same `SHARED_FRAMEWORK` constant as the lens prompts in Phase 5. |
| **The tui cast workaround becomes invalid on a pi-coding-agent upgrade** | L | M | P0.3 documents it. Add a regression test that runs `npx tsc --noEmit` and fails if the cast can be removed. |
| **Pi-lens's `git restore` bug (#23) returns when we touch files** | M | M | Document the workaround in `AGENTS.md`. Don't use `git checkout` to revert in this project. |
| **Hardcoded prompt drifts back into a `.ts` file** | M | H | The `check:no-prompt-literals` script (P0.8) runs in CI and on pre-commit. The check uses heuristics (long template literals, long double-quoted strings, `DEFAULT_*_PROMPT` identifiers) to catch regressions. Whitelist for legitimate long strings is maintained in the check script. |
| **`jiti` can't resolve `new URL("./prompts/", import.meta.url)` on Windows** | M | M | This is the bundling risk for P0.7. Mitigation: `npm pack --dry-run` includes `src/prompts/`; manual smoke test in `npm run check:no-prompt-literals`; fallback is to ship a `dist/prompts/` build artifact via a `prebuild` script (Option B in `prompt-architecture.md`). |
| **The `active-constraints.md` placeholder substitution is too naive** | L | L | First version uses a simple `{{key}}` → `value` replacement. If multi-line values or nested placeholders are needed, swap to a proper template engine (e.g., `mustache`) in a follow-up. |
| **Lens `.md` files become out of sync with the JSON output schema** | M | M | The CI check `check:no-prompt-literals` should also assert that `src/prompts/_shared/json-output.md` contains the same field list as `src/types.ts::Finding`. A small TS script extracts the field list from the interface and greps the `.md` file for each. |

---

## §5. Deferred work (out of scope for this plan)

These are real ideas but are explicitly **not** in this plan. Listed for visibility.

### Antirez-driven items

- **[DEFER-A1] "Psychological QA" / UX-cohesion lens** — antirez's "things that needed to be executed manually before". Needs commit-message context, project conventions, runtime context. Higher effort than static-analysis lenses. **Why deferred:** requires a new lens type that's qualitatively different from the existing 7; needs design discussion on what "surprising" means across languages.
- **[DEFER-A2] Markdown QA spec mode** — per-project `.pi/drykiss/qa.md` playbook that an agent follows. **Why deferred:** ortho