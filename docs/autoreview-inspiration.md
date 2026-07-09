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
