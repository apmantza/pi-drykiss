# Autoreview Inspiration and Potential Improvements

This note collects external patterns worth considering for future `pi-drykiss` autoreview work. It is intentionally an inspiration backlog, not an implementation plan.

## Sources reviewed

- Cloudflare, **Orchestrating AI Code Review at scale** — <https://blog.cloudflare.com/ai-code-review/>
- Claude Code docs, **Code Review** — <https://code.claude.com/docs/en/code-review>
- Cubic, **The false positive problem: Why most AI code reviewers fail** — <https://www.cubic.dev/blog/the-false-positive-problem-why-most-ai-code-reviewers-fail-and-how-cubic-solved-it>
- Collin Wilkins, **AI Code Review: Approaches, Trends, and Best Practices** — <https://collinwilkins.com/articles/ai-code-review-best-practices-approaches-tools>
- MindStudio, **How to Set Up Automated Code Review with Multiple AI Agents** — <https://www.mindstudio.ai/blog/automated-code-review-multiple-ai-agents>
- Microsoft Engineering, **Enhancing Code Quality at Scale with AI-Powered Code Reviews** — <https://devblogs.microsoft.com/engineering-at-microsoft/enhancing-code-quality-at-scale-with-ai-powered-code-reviews/>
- CR-Bench, **Evaluating the Real-World Utility of AI Code Review Agents** — <https://arxiv.org/html/2603.11078v1>
- CodeRabbit docs, **Path-based review instructions** — <https://docs.coderabbit.ai/configuration/path-instructions>

## High-value ideas for `pi-drykiss`

### 1. Risk-tiered review routing

**Pattern:** Cloudflare classifies reviews into trivial/lite/full tiers based on diff size and sensitive paths, then runs a different agent set per tier.

**Why it matters:** `drykiss_autoreview` currently tends toward a full flat lens fan-out. That is strong but can be noisy and expensive for tiny changes.

**Possible design:**

- Add a `riskTier` resolver before lens selection.
- Inputs:
  - changed lines
  - file count
  - path sensitivity (`auth`, `crypto`, `security`, `permissions`, `secrets`, CI config)
  - deleted/renamed files
  - package/build/test/config changes
- Defaults:
  - `trivial`: one general lens + synthesis, no validator unless requested
  - `lite`: simplicity, resilience, tests, docs/materiality
  - `full`: all lenses + stronger synthesis/validator
- Config override in `.pi/drykiss/config.json`:
  - force tiers by path
  - always include security for selected globs
  - max findings per tier

**Caution:** Project instructions currently say `/drykiss --all` should remain flat. Risk-tiering should apply to smart/default autoreview, not change explicit `--all` semantics.

### 2. Verification-first synthesis / judge pass

**Pattern:** Claude Code and Cloudflare both describe a verification step that checks candidate findings against actual code behavior before publishing. Cloudflare's coordinator deduplicates, re-categorizes, and drops speculative or convention-contradicted findings.

**Why it matters:** Our current synthesis merges and ranks, and optional validator exists, but reviews still surface findings that can be speculative or invalid after post-processing.

**Possible design:**

- Add a synthesis rule: every high/critical finding must include evidence:
  - `file:line`
  - concrete execution path or input state
  - why existing code/tests do not already cover it
- Add a cheap deterministic pre-validator:
  - file exists in scope
  - line number is positive and in range
  - suggestion/detail present
  - severity belongs to allowed set
- Add an LLM judge only for high/critical or low-confidence findings.
- Store a `verifiedBy` field or `_validatorVerdict` reason in the final result.

### 3. Stronger false-positive controls

**Pattern:** Cubic emphasizes that false positives come from diff-only, syntax-level analysis without project context. Claude Code lets teams tune a verification bar and skip rules with `REVIEW.md`.

**Why it matters:** False positives train users to ignore autoreview. DRYKISS should optimize for trusted, actionable findings over exhaustive comments.

**Possible design:**

- Require findings to identify behavior, not just suspicious shape.
- Prefer “could this actually happen?” checks over “this looks risky.”
- Use existing project index/LSP/lens graph to validate:
  - helper already exists
  - call sites affected
  - exported API consumers
  - type constraints that make a finding impossible
- Add config knobs:
  - `minConfidence`
  - `maxNits`
  - `skipPaths`
  - `onlyReportIfConcrete` for selected lenses

### 4. Per-lens “What NOT to flag” prompt sections

**Pattern:** Cloudflare explicitly credits “What NOT to Flag” prompt sections for keeping average findings low.

**Why it matters:** We already have shared grounding prompts, but lens-specific negative examples can prevent repeated low-value findings.

**Possible sections:**

- **Simplicity:** Do not flag a small local duplication if extracting it would obscure intent.
- **Deduplication:** Do not suggest reuse unless the target helper is named and compatible.
- **Clarity:** Do not report style preferences that a formatter/linter owns.
- **Resilience:** Do not say “add error handling” unless a concrete failing operation lacks handling.
- **Architecture:** Do not flag module size alone unless there is a clear change hazard.
- **Tests:** Do not request broad tests; name the missing behavior and minimal test case.
- **Security:** Do not report hypothetical injection unless untrusted input reaches a sink.
- **Docs:** Do not request docs for ordinary internal implementation details.

**Implementation note:** Prompt text must stay in `.md` files under `src/prompts/` or shared prompt fragments.

### 5. Review-only repo policy file

**Pattern:** Claude Code distinguishes general project instructions from review-specific rules using `REVIEW.md`, with support for severity tuning, skip rules, nit caps, repo-specific checks, and verification bars.

**Why it matters:** `AGENTS.md` is broad and agent-facing. A review-specific policy could be easier to maintain and less likely to pollute coding prompts.

**Possible design:**

- Look for `.drykiss/REVIEW.md`, `REVIEW.md`, or `.github/drykiss-review.md`.
- Inject it into lens prompts as review policy, after prompt-injection safeguards.
- Supported documented sections:
  - severity calibration
  - path skip rules
  - repo-specific invariants
  - max nit volume
  - finding format preferences
  - re-review convergence rules

### 6. Re-review convergence

**Pattern:** Claude Code suggests suppressing new nits after the first review so follow-up pushes do not devolve into endless style rounds.

**Why it matters:** Autoreview should converge. If a user fixes high-priority findings, a second run should not suddenly introduce unrelated low-priority work.

**Possible design:**

- Use history/rejections to detect repeat review of the same target.
- On subsequent runs:
  - only new high/critical findings by default
  - suppress new nits unless touched lines changed materially
  - group “new low-priority observations” in a non-blocking section

### 7. Finding budget and signal target

**Pattern:** Cloudflare reports deliberately low average findings per review and biases toward signal over noise.

**Why it matters:** DRYKISS currently can produce many findings, especially full-codebase reviews. A budget forces ranking discipline.

**Possible design:**

- Per-lens cap by tier:
  - trivial: max 1-2
  - lite: max 3 per lens
  - full: max 5 per lens, synthesis top N
- Let critical/security findings exceed cap.
- Add summary metadata:
  - `omittedLowPriorityCount`
  - `findingBudgetApplied: true`

### 8. Materiality reviewer for project instructions and docs

**Pattern:** Cloudflare has an AGENTS.md reviewer that flags major changes without corresponding agent-instruction updates. It uses materiality tiers.

**Why it matters:** This project itself depends heavily on `AGENTS.md` and prompt/docs conventions. Reviews should catch changes that make agent instructions stale.

**Possible design:**

- Extend docs lens or add a docs/materiality mode.
- High materiality:
  - package manager changes
  - test/build framework changes
  - new required environment variables
  - CI workflow changes
  - prompt architecture changes
  - major directory restructure
- Medium materiality:
  - significant dependency changes
  - new command/config surface
  - model/provider routing changes
- Low materiality:
  - localized bug fixes using existing patterns

### 9. Shared context artifact for lens runs

**Pattern:** Cloudflare describes shared context and prompt-cache benefits from stable repeated context.

**Why it matters:** Each lens currently gets composed context. A shared review bundle would make lens inputs easier to inspect, cache, and compare.

**Possible design:**

- Generate `.pi/drykiss/current-review/context.md` or in-memory equivalent containing:
  - target label and metadata
  - changed files
  - diffs
  - selected full-file context
  - project index
  - config/risk targeting summary
- Lenses receive the same artifact plus lens-specific instructions.
- Persist context hash in review JSON for reproducibility.

### 10. Dynamic model tiering

**Pattern:** Cloudflare reserves top-tier models for coordinator/judge work and uses cheaper models for narrower sub-reviewers.

**Why it matters:** This matches DRYKISS's architecture well: lenses can be cheap/parallel; synthesis and validation need stronger reasoning.

**Possible design:**

- Model tier by role:
  - `lens.light`
  - `lens.heavy`
  - `synthesis`
  - `validator`
- Risk tier chooses model tier.
- Retry/autoroute respects role and failed model exclusion.

### 11. Neutral/advisory check semantics

**Pattern:** Claude Code's managed review posts findings and completes neutrally; users can parse severity counts separately if they want gating.

**Why it matters:** `healthScore: 0/100` currently appears for validation/data-quality issues and can overstate review failure. Separating review health from code risk would reduce confusion.

**Possible design:**

- Distinguish:
  - `reviewStatus`: done/error/incomplete/validation-degraded
  - `codeRisk`: clean/comments/request-changes/security-review
  - `qualityGate`: pass/fail/warn
- Validation drops should degrade `reviewStatus`, not necessarily imply code risk = worst possible.

### 12. Human feedback loop and suppression ergonomics

**Pattern:** Commercial reviewers tune based on what developers accept/dismiss. Claude Code supports skip rules; Cloudflare has a break-glass override.

**Why it matters:** DRYKISS already has suppressions and rejections, but they could become first-class review interactions.

**Possible design:**

- Add commands or tool actions:
  - reject finding
  - suppress risk code
  - mark false positive
  - accept risk for target
- Persist feedback with enough context to suppress similar future findings.
- Add telemetry-free local metrics:
  - repeated false-positive categories
  - most rejected lenses
  - suppressions by riskCode

### 13. PR summary and interactive Q&A surfaces

**Pattern:** Microsoft describes AI review as more than comments: it also generates PR summaries and supports conversational Q&A inside the existing PR workflow.

**Why it matters:** `drykiss_autoreview` currently emits findings and summary text, but users may also need fast answers like “what changed?”, “what is the riskiest file?”, or “why did this finding fail validation?”

**Possible design:**

- Add a structured `reviewBrief` to `ReviewResult`:
  - intent summary
  - risky files
  - test impact
  - follow-up questions worth asking the author
- Persist enough context so a later command/tool can answer questions about the review without rerunning lenses.
- Keep Q&A read-only: answer from saved context, findings, diffs, and session logs.

### 14. Review suggestions with explicit author control

**Pattern:** Microsoft allows AI to suggest code improvements but keeps the author in control; suggestions are reviewed and explicitly accepted rather than auto-committed.

**Why it matters:** DRYKISS findings often include concrete suggestions. Turning some into patches could help, but auto-applying review fixes would be risky.

**Possible design:**

- Add optional patch suggestions for `quick-fix` findings.
- Store patches as suggestions in the report, not applied edits.
- Require an explicit follow-up action to apply a selected patch.
- Attribute generated patches to the review finding and preserve a before/after verification checklist.

### 15. Path-based review instructions and filters

**Pattern:** CodeRabbit separates path filters from path instructions. Filters skip low-value files such as lockfiles, generated code, binaries, build outputs, and media. Instructions add targeted rules for paths such as controllers, tests, and docs.

**Why it matters:** DRYKISS already has ignore patterns, but path-specific review guidance would let teams tune signal without forking prompts.

**Possible design:**

- Add config like:
  - `review.pathFilters`: exclude/force-include globs
  - `review.pathInstructions`: glob + markdown instruction
- Example uses:
  - `src/**/*Controller.ts`: require auth/input validation checks
  - `**/*.test.ts`: focus on meaningful assertions and edge cases
  - `docs/**`: docs clarity and stale command checks only
  - `src/prompts/**`: enforce prompt architecture and injection safeguards
- Treat path instructions as supplemental policy, not a replacement for normal review.

### 16. Evaluation harness with developer-utility metrics

**Pattern:** CR-Bench argues that AI code review should be evaluated on objective defect detection, usefulness, factuality, and signal-to-noise ratio, not just raw precision/recall or text similarity. It also warns that forcing more iterative reflection can raise recall while hurting signal integrity.

**Why it matters:** DRYKISS has tests for parsing and formatting, but not a benchmark that measures review usefulness or false-positive pressure across known changes.

**Possible design:**

- Create `fixtures/review-bench/` with small PR-style diffs and expected findings.
- Track metrics:
  - hit rate for seeded defects
  - false-positive count
  - usefulness rate
  - signal-to-noise ratio
  - invalid finding rate
  - duplicate finding rate
- Add benchmark modes:
  - single lens
  - flat all-lens
  - all-lens + validator
  - deep/reflection mode
- Use the harness to guard prompt edits and model-routing changes.

### 17. Avoid reflexive over-review loops

**Pattern:** CR-Bench reports a precision/recall trade-off: more aggressive reflective review can discover more defects but also add noisy, wrong, or irrelevant comments.

**Why it matters:** DRYKISS has deep-review/reflection-style options. Those should not silently become the default review path.

**Possible design:**

- Keep default `/drykiss --all` flat and bounded.
- Gate deep/reflection mode behind explicit params/config.
- Report `noiseRisk` metadata for deep runs:
  - number of passes
  - findings before/after bucketing
  - validator drops
  - low-confidence survivors
- Use deep mode for high-risk or user-requested “bug hunt,” not routine reviews.

### 18. Historical and team-pattern context

**Pattern:** Microsoft highlights ongoing work to reference past PRs and learn from human review patterns. Cubic similarly points to commit/history context as a false-positive reducer.

**Why it matters:** DRYKISS already has local history and rejection storage. It can use that as a privacy-preserving version of team-pattern memory.

**Possible design:**

- Fold local rejection/suppression history into prompts as compact policy:
  - “The user previously rejected findings like X in paths Y.”
  - “This risk code is suppressed for generated files.”
- Learn recurring accepted finding classes by risk code/path.
- Use history to lower confidence or suppress repeated false positives.
- Keep all learning local and inspectable under `.pi/drykiss/`.

## Suggested implementation order

1. Add deterministic final-result/validation cleanup and clarify review-health vs code-risk scoring.
2. Add per-lens “What NOT to flag” sections in prompt markdown.
3. Add path-based review filters/instructions.
4. Add finding budgets and max nit caps.
5. Add review-only policy file support (`REVIEW.md`-style).
6. Add a small review-benchmark harness with usefulness/SNR metrics.
7. Add risk-tiered smart default lens routing.
8. Add materiality/docs reviewer behavior.
9. Add shared context artifact and context hash.
10. Add stronger judge verification for high/critical findings.
11. Add re-review convergence rules.
12. Add first-class human feedback/suppression actions.
13. Add optional patch suggestions for quick-fix findings.
14. Add saved-review Q&A/brief surfaces.

## Open questions

- Should risk-tiering be opt-in first, or become the default for omitted
  `lens/lenses` only?
- Should validator run before or after synthesis? Before synthesis lowers noise;
  after synthesis verifies final claims.
- Should suppressed/previously rejected findings be visible in the main TUI, or
  only in structured output?
- How should health score distinguish code quality from review infrastructure failure?
- What local feedback UX should exist without adding commands back to the extension?

## pi-ecosystem survey

This section covers Pi extensions and skills found in the ecosystem that share review-related goals. Each entry summarizes the core approach and which patterns are worth adopting.

### Sources

- MattDevy, **pi-simplify** — <https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify>
- MattDevy, **pi-code-review** — <https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-code-review>
- JI4JUN, **pr-review-handler** — <https://github.com/JI4JUN/pr-review-handler>
- mrclrchtr, **supi-review** — <https://github.com/mrclrchtr/supi/tree/main/packages/supi-review>
- diegopetrucci, **contrarian** — <https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/contrarian>
- diegopetrucci, **code-reviewer** — <https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/code-reviewer>
- jayjnu, **pi-auto-review** — <https://github.com/jayjnu/pi-auto-review>
- default-anton, **pi-review** — <https://github.com/default-anton/pi-review>
- dzhng, **code-review skill** — <https://github.com/dzhng/skills/tree/main/skills/engineering/code-review>
- shadcn, **improve skill** — <https://github.com/shadcn/improve/blob/main/skills/improve/SKILL.md>

### Patterns worth adopting

### 19. Session-aware brief synthesis

**Source:** supi-review

**Pattern:** Before reviewing, synthesize a structured brief from conversation history: summary, intended outcome, constraints to preserve, focus areas, risky files, unresolved questions. The reviewer gets intent context, not just a diff dump.

**Why it matters:** pi-drykiss lenses see file diffs/context but have no idea *what the user was trying to do*. A brief from the session would let reviewers distinguish "this pattern looks wrong" from "this is a deliberate tradeoff the user accepted."

**Possible design:**

- Before lens fan-out, generate a compact brief from the active session:
  - session goal
  - key decisions
  - constraints
  - risky files
  - known tradeoffs
- Inject the brief into the user prompt for every lens.
- The synthesis lens also receives the brief for final calibration.

### 20. Self-contained fix plans

**Source:** shadcn/improve

**Pattern:** Instead of just findings, write self-contained implementation plans for OTHER agents to execute. Each plan includes: exact file paths, current-state code excerpts, ordered steps, verification commands, done criteria, and dependency ordering. The reviewer never edits code itself.

**Why it matters:** Findings tell you *what* is wrong. Plans tell you *how* to fix it. A `/drykiss-improve` mode that produces executable plans would dramatically reduce the gap between review and action.

**Possible design:**

- Add a `--plans` mode to `drykiss_autoreview`.
- For high-priority findings, write a plan file under `.pi/drykiss/plans/`:
  - stamped with current `HEAD`
  - dependency ordering between plans
  - machine-checkable done criteria
  - test plan with concrete assertions
  - escape hatches for surprising results
- Plans declare required verifier commands (lint, typecheck, test).
- Plan index (`plans/README.md`) tracks status for executors to update.

### 21. Adversarial model routing

**Source:** contrarian, code-reviewer (diegopetrucci)

**Pattern:** Prefer opposite-provider and opposite-family model for review. If the session uses Claude, review with GPT. Falls back to same-provider if no cross-provider model is available.

**Why it matters:** Different models make different kinds of mistakes. A bug Claude overlooks may be obvious to GPT, and vice versa. pi-drykiss already has model selection, but doesn't deliberately pick cross-provider models.

**Possible design:**

- Add a `oppositeModel` preference to config.
- During lens model resolution, compare each configured model provider/family against the session model.
- Prefer models from a different provider.
- Fallback: same provider, different family → first available.
- Synthesis/validator use the session model (needs highest reasoning; provider doesn't matter).

### 22. Reviewer profiles with merge-by-ID config

**Source:** pi-auto-review (jayjnu)

**Pattern:** Review behavior is configured as named profiles. Each profile has: agent, model, skills, task, taskExtra, label. Global and project config files merge by profile ID. Project overrides can add new profiles, override fields, inherit omitted fields, or disable global profiles with `enabled: false`.

**Why it matters:** pi-drykiss lens configuration is currently flat and global. Per-lens model overrides exist but aren't a general profile system. Reviewer profiles would allow teams to add, customize, or disable lenses without forking prompts.

**Possible design:**

- Refactor lens config into profiles:
  - `lensProfiles`: array of `{ id, model, task?, skills?, enabled? }`
  - merged by ID from global → project config
  - `enabled: false` to disable a lens without removing it
- Profiles can add extra `task` instructions that append to the lens prompt.
- Profiles can reference `skills` for extra subagent context.

### 23. Host-derived verdict from normalized items

**Source:** supi-review

**Pattern:** The reviewer submits items + overall confidence. The host derives the binary verdict from normalized items: `must-fix` items → `PATCH HAS ISSUES`. No must-fix items → `PATCH IS CORRECT`. The model doesn't decide the final verdict.

**Why it matters:** pi-drykiss already does this implicitly via synthesis: the lens LLMs return findings, and synthesis produces the verdict. But making this explicit would prevent edge cases where synthesis produces a verdict that contradicts the findings.

**Possible design:**

- After synthesis, run a deterministic verdict overrides phase:
  - if critical/high findings with `action: fix` → verdict stays "Request changes" regardless of synthesis output
  - if zero findings with `action: fix` and synthesis says "Request changes" → downgrade to "Approve"
  - if validator refuted ALL critical findings → downgrade verdict severity
- Report `verdictSource: synthesis | deterministicOverride` in metadata.

### 24. Effort/concentration levels for review depth

**Source:** shadcn/improve

**Pattern:** Three effort levels control audit breadth, subagent count, and finding confidence:

- `quick`: hotspots only, 0–1 subagents, top 6 high-confidence findings
- `standard` (default): hotspot-weighted, ≤4 subagents, full table
- `deep`: whole repo, ≤8 subagents, including low-confidence "investigate" items

**Why it matters:** Maps directly to risk-tiered routing, but adds explicit user-facing depth control.

**Possible design:**

- Add `depth: quick | standard | deep` to `drykiss_autoreview` params.
- `quick`: only simplicity + security lenses, max 2 findings per lens.
- `standard`: all lenses, budgeted findings.
- `deep`: all lenses + validator + project index, unlimited findings but with floor.
- Also controls context mode: quick = `diff`, deep = `full`.

### 25. Review-plan preview / inspector

**Source:** supi-review

**Pattern:** Before the review runs, show what the reviewer will see. In-app inspector with Overview mode (review instruction blocks, file overview, truncated notes) and Raw Prompt mode. User can inspect, export, or cancel before paying for the review.

**Why it matters:** Reduces surprise findings and wasted runs. Gives the user a chance to catch misconfigurations or wrong scope before token spend.

**Possible design:**

- After scope resolution but before lens fan-out, generate a review plan summary:
  - target files
  - selected lenses
  - configured models
  - active constraints
  - estimated token cost
- Render it in the TUI with an option to cancel before proceeding.
- Expose the full composed prompt for each lens in a preview mode.

### 26. Vet-before-presenting with rejection tracking

**Source:** shadcn/improve

**Pattern:** Subagents over-report. Before presenting findings, open every cited file yourself and confirm. Three rejection classes: by-design behavior, mis-attributed evidence, duplicates. Record rejections so they aren't re-audited next run.

**Why it matters:** pi-drykiss already has rejection tracking. Formalizing the vet step between synthesis and output would catch nonsense findings before the user sees them.

**Possible design:**

- After synthesis, before building the final `ReviewResult`:
  - deterministic pre-validate each finding (file in scope, line > 0, severity valid, required fields present)
  - check against known suppressions and rejections
  - tag rejected findings with `_rejectedReason: by-design | wrong-evidence | duplicate | outside-scope`
- Surface vetted counts vs raw synthesis counts in the report.
- Record rejections in local history so they inform future reviews.

### 27. Language-aware auto-inject with targeted checklists

**Source:** pi-code-review (MattDevy)

**Pattern:** After each edit turn, inject a brief language-specific review checklist into the system prompt. Supports TypeScript, Python, Go, Rust, Java, PHP. The checklist is tuned per language.

**Why it matters:** pi-drykiss has auto-inject via `buildAutoInjectBlock` in `src/auto-inject.ts`, but the checklist is generic KISS/DRY. Language-specific checklists would catch language-idiomatic issues before lens review.

**Possible design:**

- Detect language from edited file extensions.
- Inject targeted check items:
  - TypeScript: type safety, async error handling, null/undefined risks
  - Python: exception handling, mutable default args, type hints
  - Go: `err != nil` patterns, goroutine leaks
  - Rust: `unwrap` usage, lifetime issues
  - Java: null safety, checked exceptions
  - PHP: type coercion, unsafe unserialize
- Keep the checklist short (3–5 items) so it doesn't bloat the prompt.

### 28. Triage → fix → verify → reply pipeline

**Source:** pr-review-handler (JI4JUN)

**Pattern:** A structured multi-phase pipeline for PR reviews:

1. Triage: classify each review thread as `valid-fix`, `valid-nofix`, or `invalid`.
2. Fix: apply minimal changes per valid-fix thread. Commit locally.
3. Verify: run type checker. If it fails, unstage, fix, recommit.
4. Reply: draft replies matching the reviewer's language and tone.
5. Post & push: post replies, auto-resolve conversations, push fix commit.
6. Report: summary of triage/fix/reply/resolve counts.

Phase 1 triage runs in parallel with isolated subagents. Phase 2 is serial.

**Why it matters:** This is a complete PR-responder workflow, not just a reviewer. pi-drykiss already finds issues but doesn't help fix or reply to them.

**Possible design:**

- Add a `/drykiss-respond` or `--respond` mode for PR reviews:
  - fetch unresolved review threads
  - triage each against current findings and code
  - for valid-fix findings, apply minimal fix
  - run typecheck after fixes
  - draft replies with finding evidence
- Keep the triage subagent read-only and parallel.
- Keep the fix subagent as the single writer.
- Require human confirmation before post/push.

### 29. Priority codes (P0–P3) as first-class severity signal

**Source:** pi-review (default-anton)

**Pattern:** Findings are sorted by priority codes:

- P0: severe breakage, data loss, or security issue
- P1: likely user-facing breakage or major regression
- P2: limited-scope correctness, performance, or maintainability
- P3: minor but real issue

This is displayed prominently in the output, often more visible than severity.

**Why it matters:** pi-drykiss already has priority fields on findings, but they aren't emphasized in the TUI or summary. A clear P0–P3 badge would help users triage faster.

**Possible design:**

- Render priority badges in the TUI completed summary.
- Sort findings by priority within severity groups.
- Add filter config: `minPriority` to suppress P3 findings.
- In compact format output, include priority code next to severity.

### 30. Snapshot-aware / on-demand diff fetching

**Source:** supi-review

**Pattern:** Instead of receiving bulk inline diffs, the reviewer gets snapshot-aware tools (`read_snapshot_diff`, `read_snapshot_file`) to fetch per-file diffs and content on demand.

**Why it matters:** For large reviews, giving every lens the full diff of every file is token-expensive. On-demand fetching lets lenses pay for what they actually inspect.

**Possible design:**

- Add config option: `contextMode: on-demand` in addition to `diff` and `full`.
- Lenses receive file manifest and metadata only.
- Lenses use snapshot tools to fetch diffs and contents for files they want to inspect.
- Currently lower priority: pi-drykiss's current approach (full-context + diff in user prompt) is simpler and works well. This would add complexity and tool-surface area for marginal token savings in most reviews.

## Prioritized next additions for pi-drykiss (from pi-ecosystem survey)

1. **Session-aware brief synthesis** — inject intent context into lens prompts.
2. **Adversarial model routing** — prefer cross-provider models for review.
3. **Effort/concentration levels** — quick/standard/deep depth control.
4. **Reviewer profiles with merge-by-ID config** — flexible lens config from global + project.
5. **Self-contained fix plans** — `/drykiss-improve` that writes executable plans.
6. **Vet-before-presenting with rejection tracking** — formalize the post-synthesis vet step.
7. **Host-derived verdict from normalized items** — deterministic verdict overrides.
8. **Review-plan preview** — show scope/lenses cost before running.
9. **Priority codes as first-class TUI signal** — P0–P3 badges in output.
10. **Triage → fix → verify → reply pipeline** — full PR responder workflow.
11. **Language-aware auto-inject** — language-specific edit-turn checklists.
12. **Snapshot-aware / on-demand diff fetching** — lower priority, marginal gain.

## Updated suggested implementation order (merged)

1. Add deterministic final-result/validation cleanup and clarify review-health vs code-risk scoring.
2. Add per-lens "What NOT to flag" sections in prompt markdown.
3. Add session-aware brief synthesis.
4. Add effort/concentration levels (quick/standard/deep).
5. Add adversarial model routing.
6. Add path-based review filters/instructions.
7. Add finding budgets and max nit caps.
8. Add review-only policy file support (REVIEW.md-style).
9. Add reviewer profiles with merge-by-ID config.
10. Add a small review-benchmark harness with usefulness/SNR metrics.
11. Add risk-tiered smart default lens routing.
12. Add self-contained fix plans (drykiss-improve).
13. Add materiality/docs reviewer behavior.
14. Add vet-before-presenting with rejection tracking.
15. Add shared context artifact and context hash.
16. Add stronger judge verification for high/critical findings.
17. Add host-derived verdict from normalized items.
18. Add re-review convergence rules.
19. Add review-plan preview.
20. Add first-class human feedback/suppression actions.
21. Add priority codes as first-class TUI signal.
22. Add optional patch suggestions for quick-fix findings.
23. Add saved-review Q&A/brief surfaces.
24. Add triage → fix → verify → reply pipeline.
25. Add language-aware auto-inject.
26. Add snapshot-aware / on-demand diff fetching.
