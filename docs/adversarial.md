# Adversarial Code Review — Research & Inspiration

Survey of adversarial and multi-pass LLM code review techniques (2025-2026) for informing DRYKISS's deep-review pipeline, validator stage, and future enhancements.

## 1. Refute-or-Promote (Stage-Gated Multi-Agent Review)

**Source:** [arxiv.org/pdf/2604.19049](https://arxiv.org/pdf/2604.19049)

An adversarial stage-gated methodology for high-precision LLM-assisted defect discovery. Key mechanisms:

- **Adversarial kill mandates** — each agent is incentivised to disprove the previous agent's findings rather than confirm them. This targets false positives that cooperative debate misses.
- **Context asymmetry** — reviewers see different context slices (e.g., one sees the diff, another sees the full file, a third sees only the function signature). Agreement across asymmetric contexts is a stronger signal.
- **Cross-Model Critic (CMC)** — a different model family validates findings from the primary reviewer. Cross-model agreement reduces single-model hallucination risk.

**Relevance to DRYKISS:** The deep-review pipeline (5 adversarial passes + validator) already covers multi-pass. The CMC pattern is a natural extension: run the validator on a different model than the lens that produced the finding. Context asymmetry could be implemented via the existing `contextMode: "diff" | "full"` config — alternate passes between modes.

## 2. Multi-Review Aggregation

**Source:** [zylos.ai/research/2026-03-01-multi-model-ai-code-review-convergence](https://zylos.ai/research/2026-03-01-multi-model-ai-code-review-convergence/)

Running the same PR through n independent LLM review passes, then using an aggregator LLM to synthesise findings.

- Gemini-2.5-Flash with Self-Aggregation at n=10 runs achieved F1 of 21.91% (43.67% improvement over single-pass baseline).
- Recall improved by 118.83% — multi-pass catches significantly more real bugs.
- Diminishing returns beyond n=7-10 passes.

**Relevance to DRYKISS:** The bucketing + synthesis pipeline is architecturally ready for arbitrary pass counts. The deep-review default of 5 passes is conservative; for high-value reviews (security, architecture), 7-10 passes with varied temperature seeds could be worth the cost.

## 3. Actor-Critic Pattern

**Source:** [understandingdata.com/posts/actor-critic-adversarial-coding](https://understandingdata.com/posts/actor-critic-adversarial-coding/)

Directly mirrors reinforcement learning's actor-critic framework for code quality:

- **Actor** generates or reviews code (produces findings).
- **Critic** adversarially attacks the findings (tries to prove them wrong).
- Loop continues for 3-5 rounds until the critic approves or max iterations reached.
- Result: higher-quality findings reaching human review, reducing review cycles from 3-5 to 1-2.

**Relevance to DRYKISS:** The validator stage is already a single-round critic. Extending to multi-round actor-critic (lens produces findings, validator refutes, lens re-examines, validator re-validates) would increase precision at the cost of additional model calls. Could be gated behind a `thoroughness: "high"` config.

## 4. BugBot Production Data (Sentry, 2026)

BugBot achieved a 70% resolution rate across 2M+ PRs/month by January 2026, up from 52% in its original design. Key factors:

- Multi-pass with varied focus seeds (different aspects of the same code).
- Deduplication via embedding similarity (DRYKISS uses Jaccard + line proximity — embeddings could improve clustering).
- Severity calibration from historical resolution rates (findings that humans actually fix are weighted higher).

**Relevance to DRYKISS:** The rejection memory system (downranking previously-dismissed findings) is a form of calibration. Tracking which findings are accepted vs dismissed in triage (FEAT-6) could feed back into severity calibration over time.

## 5. The False Positive Crisis

- curl's bug bounty program was **permanently closed** after AI-generated submissions drove the confirmed rate below 5%.
- HackerOne paused the Internet Bug Bounty programme in March 2026 citing AI-amplified submission volume overwhelming triage capacity.
- 78% of teams have experienced a critical false negative from automated scanning tools.
- Support for fully automated pentesting fell to 9% (from 29%) in one year.
- 47% now prefer a hybrid human+AI model.

**Key insight:** LLMs are optimised for plausibility, not correctness. The validator stage, rejection memory, and suppression system in DRYKISS are direct responses to this — but the arms race continues.

**Mitigations documented in literature:**
- Runtime verification (dynamic testing) effectively suppresses false positives in vulnerability detection.
- Cross-model validation (CMC) reduces single-model hallucination.
- Historical resolution tracking (which findings do humans actually fix?) recalibrates severity.
- Confidence scoring with explicit "uncertain" labels rather than forcing a binary verdict.

## 6. Actionable Next Steps for DRYKISS

Based on this research, ordered by impact/effort ratio:

1. **Cross-model validator** — run the validator on a different model family than the lens. Low effort (model selection is already per-stage configurable via `lensModels`), high impact on false positive reduction.

2. **Triage feedback loop** — use triage accept/dismiss data to recalibrate severity scores over time. Medium effort (triage is implemented, needs a feedback pipeline to prompt weights).

3. **Confidence scoring** — require lenses to emit a `confidence: number` field alongside findings. Findings below a threshold get downranked automatically. Low effort (schema change + prompt update).

4. **Context asymmetry passes** — alternate deep-review passes between `contextMode: "diff"` and `contextMode: "full"`. Agreement across modes is a stronger signal. Low effort (config already exists per-lens).

5. **Embedding-based deduplication** — replace or supplement Jaccard similarity with embedding cosine similarity for more semantic clustering. Medium effort (needs an embedding model call, but could use a cheap local model).

6. **Configurable pass count** — expose `deepPasses: number` (default 5) for deep-review mode. Trivial effort, lets users trade cost for thoroughness.
