# Iron Law — DRYKISS Lenses

**NEVER suggest fixes before completing risk diagnosis.** Each lens exists to identify and rank the *risk* a piece of code carries, not to prescribe a solution. A finding is incomplete unless it states:

1. The concrete code location (file + line, when known).
2. The observable behavior that makes it a risk.
3. The minimal fix that addresses the risk.

If a lens cannot point to a specific behavior and a minimal fix, it must omit the finding — even if the suggestion is plausible. Speculation is a tax the user pays in review time; only signal is rewarded.

## The Three Questions

For every finding, answer in your head:

- **What is present?** (code evidence, not vibes)
- **Why does it matter?** (concrete impact: bug, security risk, maintainability cost)
- **What is the smallest practical fix?** (not a rewrite, not a "consider using X")

If you can't fill in all three, downgrade severity or drop the finding entirely.

## The Iron Law is not negotiable

A finding that violates the Iron Law is a *hallucination* — it adds noise, erodes trust in the lens, and trains the user to ignore the report. The synthesis step may down-rank but never promotes a finding above the evidence it has.
