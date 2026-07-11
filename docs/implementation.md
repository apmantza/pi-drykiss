<!-- markdownlint-disable MD013 -->

# Autoreview Implementation Proposal

This document turns the ideas in `autoreview-inspiration.md` into an incremental plan for `pi-drykiss`. The goal is not to implement every surveyed feature. The goal is to improve trust, signal, and cost control without changing the core architecture: independent parallel lenses followed by synthesis.

## Recommendation

Build the next version around one explicit `ReviewPlan` and one deterministic finalization pipeline:

1. resolve scope and policy;
2. create a review plan;
3. build one shared, redacted context bundle;
4. run the selected lenses in parallel;
5. synthesize and optionally verify selected findings;
6. deterministically derive status, risk, verdict, score, and budgets;
7. persist the plan and outcome for reproducibility.

Do not add nested agents to the normal `all` path. Keep explicit `lens`, `lenses`, and `lens: "all"` behavior stable.

## Existing baseline

Several inspiration items are already partly or fully implemented and should be extended rather than rebuilt:

- All lens prompt files already have lens-specific **What NOT to Flag** guidance.
- `review-result.ts` already performs deterministic shape/scope validation.
- `validator.ts` provides a default-on, fail-open adversarial LLM validator; `validate: false` is an explicit opt-out.
- `review-guidelines.md` and `REVIEW_GUIDELINES.md` already provide review-only policy.
- `ignorePatterns`, risk targeting, suppressions, and rejection downranking already reduce noise.
- Findings already support P0-P3 priority and validator metadata.
- Deep review is explicit and separate from the default flat fan-out.
- Lens outputs are bucketed before synthesis.

The remaining gaps are a central review plan, session-intent context, shared context hashing, and role-aware model routing. Deterministic finalization, path policy, finding budgets, selective validation, and the benchmark harness now exist.

## Design constraints

- Prompt text remains exclusively in Markdown under `src/prompts/`.
- `/drykiss --all` and `lens: "all"` remain a flat parallel fan-out plus synthesis.
- Existing callers and persisted reviews remain readable.
- Validation failures are review-infrastructure problems, not proof that the code is bad.
- Model calls fail open: unverified findings remain visible and are never silently approved.
- Project content and policy are treated as untrusted data under the existing prompt-injection safeguards.
- New TUI behavior must degrade cleanly in print, JSON, and RPC modes.

---

## Milestone 1 — Deterministic finalization and honest result semantics

### Problem — deterministic result semantics

`buildReviewResult()` currently assigns a health score of zero when a lens fails or a synthesized finding fails structural validation. This combines two separate facts:

- whether the review completed reliably;
- whether the reviewed code contains risky findings.

The final ignore filter in `review-command.ts` also rebuilds only part of the result, so counts, cleanliness, score, and verdict can diverge after filtering.

### Proposal — deterministic finalizer

Add `src/review-finalizer.ts` and make it the only place that constructs the externally visible result. It should apply, in order:

1. structural validation;
2. severity overrides;
3. path/risk filters;
4. suppressions and previous rejections;
5. optional validator verdicts;
6. finding budget;
7. deterministic verdict and score derivation.

Introduce these fields while retaining the current fields for compatibility:

```ts
type ReviewStatus = "done" | "incomplete" | "error" | "validation-degraded";
type CodeRisk = "clean" | "comments" | "request-changes" | "security-review";
type GateStatus = "pass" | "warn" | "fail";

interface ReviewResult {
  reviewStatus: ReviewStatus;
  codeRisk: CodeRisk;
  qualityGate: {
    status: GateStatus;
    threshold: number;
    score: number;
    reasons: string[];
  };
  verdictSource: "deterministic";
}
```

`healthScore` should be computed only from active code findings. An incomplete review may have `healthScore: 100` and `reviewStatus: "incomplete"`; the quality gate should still be `warn` or `fail` because evidence is missing. This is more honest than inventing a critical code finding to force a zero score.

Derive the verdict from normalized findings rather than trusting synthesis:

- verified P0/P1 security findings with `action: "fix"` → `Needs security review`;
- other active critical/high findings with `action: "fix"` → `Request changes`;
- no blocking findings → `Approve`;
- incomplete or degraded review affects `reviewStatus` and the gate, not the code verdict.

Synthesis remains responsible for semantic deduplication, ranking, and summary text, but not the authoritative verdict.

### Files

- New: `src/review-finalizer.ts`, `src/review-finalizer.test.ts`
- Update: `src/review-result.ts`, `src/review-manager.ts`, `src/review-command.ts`
- Update: `src/compact-format.ts`, `src/review-widget.ts`, `src/types.ts`
- Update persisted schema in `src/persist.ts` with backward-compatible optional fields

### Acceptance criteria

- Filtering a finding cannot leave stale counts, score, verdict, or `clean` state.
- A failed lens can never display as a complete clean review.
- A failed lens does not manufacture worst-possible code risk.
- An empty successful review always approves.
- Deterministic verdict tests cover synthesis/verdict contradictions.

---

## Milestone 2 — Unified review policy and path-specific routing

### Problem — path-specific policy

The project supports global scope ignores and one review-guidelines file, but cannot express “review this path with these checks” separately from “exclude this path.”

### Proposal — unified policy

Add `src/review-policy.ts` with a normalized policy model:

```ts
interface ReviewPolicy {
  sourceFiles: string[];
  markdown: string | null;
  pathFilters: {
    exclude: string[];
    forceInclude: string[];
  };
  pathInstructions: Array<{
    glob: string;
    instruction: string;
    lenses?: ReviewLens[];
  }>;
  maxNits?: number;
  minPriority?: "P0" | "P1" | "P2" | "P3";
}
```

Policy-file lookup order:

1. `.pi/drykiss/REVIEW.md`
2. `.pi/drykiss/review-guidelines.md`
3. `REVIEW.md`
4. `.github/drykiss-review.md`
5. `REVIEW_GUIDELINES.md`

Use the first readable file and warn when higher-priority files are unreadable. Keep the current names as supported aliases.

Extend `.pi/drykiss/config.json`:

```json
{
  "review": {
    "pathFilters": {
      "exclude": ["**/*.lock", "dist/**"],
      "forceInclude": ["src/prompts/**"]
    },
    "pathInstructions": [
      {
        "glob": "src/prompts/**",
        "lenses": ["security", "docs"],
        "instruction": "Check prompt architecture and injection safeguards."
      }
    ],
    "maxNits": 2,
    "minPriority": "P3"
  }
}
```

Precedence should be deterministic:

1. unsupported/binary files remain excluded;
2. `forceInclude` wins over ordinary excludes;
3. explicit `mode: "files"` wins over configurable excludes but not unsupported-file safety checks;
4. path instructions supplement lens prompts and never replace shared grounding rules.

Only inject instructions matching files in the current scope. Delimit them as repository-provided review policy, not system instructions.

### Files — policy modules

- New: `src/review-policy.ts`, `src/review-policy.test.ts`
- Update: `src/config.ts`, `src/review-scope.ts`, `src/prompt-builder.ts`
- Add shared prompt framing in `src/prompts/_shared/`
- Update config and prompt-composition tests

### Acceptance criteria — policy

- Filter precedence is unit-tested for explicit files, force-includes, and ordinary excludes.
- Instructions for one glob never leak into unrelated paths.
- Existing guideline files continue to work unchanged.
- Repository policy cannot override output format, secret handling, or prompt-injection safeguards.

---

## Milestone 3 — Finding budgets and selective verification

### Finding budget

Add a deterministic budget after synthesis. Do not rely only on prompts to honor limits.

Recommended defaults:

| Review class | Active finding cap | Nit cap |
| --- | ---: | ---: |
| quick/trivial | 3 | 0 |
| standard/lite | 8 | 2 |
| standard/full | 15 | 3 |
| deep or explicit audit | configurable | configurable |

Critical findings and verified security findings may exceed the cap. Rank survivors by severity, priority, validator verdict, cross-lens votes, confidence, and changed-line proximity. Persist omitted findings outside the main rendered list and expose:

```ts
omissions: {
  findingBudgetApplied: boolean;
  omittedLowPriorityCount: number;
  omittedNitCount: number;
}
```

### Selective validator

Refactor `validator.ts` so the normal validator judges only findings that benefit from another model call:

- all critical/high findings;
- single-lens low-confidence findings;
- findings explicitly marked for discussion when evidence is weak.

Run structural validation before the LLM validator. A validator-confirmed false positive should move to a structured `discardedFindings` section and not count toward code risk. Validator failure leaves the finding active with `_validatorVerdict: "unverified"` and degrades `reviewStatus` only when validation was required by the plan.

Rename misleading counters such as `droppedFalsePositives` if the finding is merely annotated rather than dropped.

### Files — budget and validation

- New: `src/finding-budget.ts`, tests
- Update: `src/validator.ts`, `src/review-finalizer.ts`, `src/types.ts`
- Update: synthesis and validator Markdown prompts only where contract changes require it

---

## Milestone 4 — Evaluation harness before adaptive routing

Risk routing and prompt changes should be measured before they become defaults.

Add `fixtures/review-bench/` with small PR-style cases. Each fixture should contain:

- manifest and diff;
- optional full-file context;
- expected finding matchers (`riskCode`, path, line range, minimum severity);
- allowed non-findings;
- known false-positive traps;
- materiality expectation.

Add `scripts/review-bench.ts` and a deterministic scorer for:

- seeded-defect hit rate;
- false-positive count;
- invalid and out-of-scope finding rate;
- duplicate rate;
- usefulness rate;
- signal-to-noise ratio;
- estimated calls/tokens and elapsed time.

Live-model runs should be opt-in and write versioned JSON artifacts. CI should test the fixture parser and scorer, not depend on model output. A prompt or routing change is acceptable only when it does not materially reduce high-severity hit rate and improves or preserves signal-to-noise ratio on recorded comparisons.

---

## Milestone 5 — Central `ReviewPlan`, risk tiers, and effort levels

### Why a plan is needed

Scope, lenses, context, models, validation, and budgets are currently resolved in different modules. Adaptive behavior will become hard to explain unless all decisions are captured before lens execution.

### Proposed type

```ts
interface ReviewPlan {
  id: string;
  target: ReviewResultTarget;
  explicitLensSelection: boolean;
  effort: "quick" | "standard" | "thorough";
  riskTier: "trivial" | "lite" | "full";
  riskSignals: Array<{ code: string; reason: string }>;
  lenses: ReviewLens[];
  contextMode: "diff" | "full";
  validator: "off" | "selective" | "required";
  findingBudget: { total: number | null; nits: number | null };
  policySources: string[];
  contextHash: string;
}
```

Use `effort`, not `depth`, because the existing `deep` parameter already means a single-lens multi-pass Bugbot-style review. `deep` remains explicit and unchanged.

### Risk resolver

Add `src/review-planner.ts`. Signals should be deterministic and inspectable:

- changed lines and file count;
- auth, crypto, permissions, secrets, CI, release, migration, and dependency paths;
- deleted or renamed files;
- package, build, test-framework, config, and prompt-architecture changes;
- public API/export changes;
- tests changed or absent for production changes.

Recommended routing when lenses are omitted:

- `trivial`: simplicity + clarity; add docs for documentation-only changes;
- `lite`: simplicity + resilience + tests; add security for sensitive paths;
- `full`: all configured lenses, flat and parallel.

Explicit `lens`, `lenses`, or `lens: "all"` always wins over inferred routing. Security force-inclusion may add security only when the user did not explicitly select lenses.

To obtain real cost savings, split scope collection into two stages:

1. manifest/diff collection;
2. plan-dependent hydration of full contents and project index.

Do not collect all full-file content before classifying a trivial review.

### Plan preview

Return the plan in structured tool details for every mode. In TUI autoreview, optionally show a confirmation summary using the existing `confirmBeforeRun` behavior. Do not add a second mandatory prompt. Print/JSON/RPC modes continue without interactive preview.

---

## Milestone 6 — Session-aware brief and shared context bundle

### Session brief

Add `src/session-brief.ts`. Use `ctx.sessionManager.buildContextEntries()` so the brief follows the active branch and compaction state. Exclude tool payloads, secret-like values, and unrelated old branches.

The brief should contain:

- current user goal;
- intended outcome;
- constraints and decisions;
- known tradeoffs;
- unresolved questions;
- files emphasized by the session.

Default to a deterministic extraction from recent user/assistant messages. Allow an optional LLM-generated brief for `thorough` reviews only. Any summarizer instructions must live in `src/prompts/_shared/session-brief.md`.

The user can disable session context with `review.sessionBrief: "off"`. Headless tool calls still work because `ExtensionContext` exposes the active `SessionManager`.

### Shared context bundle

Add `src/review-context.ts` and build one immutable bundle consumed by every lens:

```ts
interface ReviewContextBundle {
  plan: ReviewPlan;
  sessionBrief?: SessionBrief;
  files: ChangedFile[];
  diffs: Map<string, string>;
  contents?: Map<string, FileContent>;
  projectIndex?: ProjectIndexEntry[];
  policy: ReviewPolicy;
  hash: string;
}
```

Hash the canonical redacted representation with SHA-256. Store the hash in every persisted review. Persisting source context should be opt-in because even redacted code can be sensitive. Avoid a shared `current-review` path, which is unsafe for concurrent jobs; use the review ID when persistence is enabled.

---

## Milestone 7 — Role-aware and adversarial model routing

Do not automatically pick an arbitrary expensive model merely because it belongs to another provider. Introduce role-aware routing over a configured candidate set:

```json
{
  "modelRouting": {
    "preferDifferentProvider": true,
    "candidates": ["claude", "gpt", "gemini"],
    "roles": {
      "lens.light": "haiku",
      "lens.heavy": "sonnet",
      "synthesis": "sonnet",
      "validator": "gpt"
    }
  }
}
```

Resolution precedence:

1. internal explicit model override;
2. per-lens configured model;
3. role model;
4. different-provider candidate compatible with autoroute/free-model policy;
5. existing default and popup fallback.

The planner maps trivial/quick lenses to `lens.light`, high-risk lenses to `lens.heavy`, and synthesis/validator to their own roles. Retries continue excluding the failed model and preserve the role.

Add provider/family selection tests to `model-selector.test.ts` and retry tests to `review-manager.test.ts`.

---

## Later workflows

These should follow the trust and planning work rather than expanding the default reviewer immediately.

### `/drykiss-improve`

Implement as a post-synthesis advisor, not another default lens. It reads a saved review and writes self-contained plans under `.pi/drykiss/plans/<review-id>/`. Each plan includes exact paths, ordered steps, dependencies, verification commands, done criteria, and the source finding ID. The advisor is read-only and never applies patches.

### Re-review convergence

Persist a target fingerprint, context hash, finding fingerprints, and changed hunks. On a related rerun, suppress new low/nit findings outside materially changed hunks while continuing to show new critical/high findings. Previously rejected findings remain inspectable rather than silently deleted.

### Feedback actions

Add local actions for `reject`, `suppress risk code`, `mark false positive`, and `accept risk`. Reuse `rejections.ts` and project config rather than creating a second memory store. Keep all data local and human-readable.

### Review brief and Q&A

Persist a compact `reviewBrief` containing intent, risky files, test impact, and suggested author questions. A later read-only command can answer from the saved plan, brief, findings, and diff metadata without rerunning lenses.

### Deferred

Defer auto-generated patches, PR thread fixing/replies, reviewer profiles with arbitrary skills, and on-demand snapshot tools until the benchmark shows a clear need. They add significant write authority or configuration complexity without first improving review trust.

---

## Migration and compatibility

- Add new result fields as optional for old persisted reviews.
- Keep `status`, `verdict`, `healthScore`, and existing counts during a deprecation window.
- Keep `validate` as an override; map it to the planner's validator mode.
- Keep existing `ignorePatterns`, `riskTargeting`, and guideline filenames.
- Keep existing `deep` behavior and avoid a conflicting `depth` option.
- Version persisted review records and the context hash canonicalization format.
- Warn on unknown config fields and invalid globs; do not abort an otherwise valid review.

## Recommended delivery order

1. Deterministic finalizer and separated review/code status.
2. Unified policy loading and path instructions.
3. Finding budgets and selective validator behavior.
4. Benchmark fixtures and scorer.
5. `ReviewPlan`, risk tiers, effort levels, and plan preview.
6. Session brief and shared context hash.
7. Role-aware/adversarial model routing.
8. `/drykiss-improve` and re-review convergence.
9. Feedback and saved-review Q&A.

Each milestone should ship independently with tests and pass:

```bash
npm test
npm run typecheck
npm run check:no-prompt-literals
```

Use `npm run check` for release candidates, including the dependency audit.
