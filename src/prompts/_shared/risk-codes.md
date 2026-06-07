---
# Risk code catalogue — see ../risk-codes.ts for the runtime source of truth.
#
# The .ts file is the typed barrel; this .md is the human-readable documentation.
# Each code has: code, name, diagnosticQuestion, sources, severityGuide.
# Sources are the lens names that can produce findings of this risk.
---

# Risk Codes (DRYKISS + brooks-lint)

DRYKISS uses a hybrid risk-code system: 12 codes inspired by brooks-lint's
decay-axis model (R1–R6, T1–T6) plus 7 DRYKISS-specific extensions. The
codes are what `disable`, `severity`, `focus`, and `suppress` config keys
target — they're the most fine-grained handle you have on review output.

Two categories:

- **R* (rot)** — risks of decay from change over time
- **T* (test)** — risks of incorrectness at the point of writing

## R-codes (rot)

| Code | Name | Diagnostic question | Sources |
|---|---|---|---|
| R1 | Divergent change | Does the same conceptual change require edits in N places? | simplicity, deduplication |
| R2 | Shotgun surgery | Does a small change force a wide fan-out of edits? | simplicity, deduplication |
| R3 | Inappropriate intimacy | Do classes/modules know too much about each other's internals? | architecture, clarity |
| R4 | Refactor backlog | Are TODOs / `// FIXME` / hacks accumulating without attention? | simplicity, resilience |
| R5 | Lost intent | Are magic numbers, opaque flags, or unexplained names creeping in? | clarity |
| R6 | Leaky abstraction | Does the API expose implementation details to its callers? | architecture, clarity |

## T-codes (test / correctness)

| Code | Name | Diagnostic question | Sources |
|---|---|---|---|
| T1 | Missing test | Is there a test that would catch a regression in this code path? | tests |
| T2 | Brittle assertion | Does the test rely on implementation details (mocks, snapshot, exact string)? | tests |
| T3 | Tautological test | Does the test re-implement the production logic, then compare to itself? | tests |
| T4 | Coverage gap on failure path | Are error / boundary / null paths exercised? | tests, resilience |
| T5 | Untested integration | Do modules communicate correctly across boundaries? | tests, architecture |
| T6 | Property violation | Does the code violate an invariant the type system should enforce? | tests, resilience, security |

## DRYKISS extensions

| Code | Name | Diagnostic question | Sources |
|---|---|---|---|
| K1 | KISS violation | Is the code more complex than the problem demands? | simplicity |
| D1 | Duplication | Is the same knowledge expressed in two places? | deduplication |
| C1 | Clarity hit | Is the code's intent unclear at the point of reading? | clarity |
| R7 | Resilience gap | Will the code fail in an unhelpful way under load / partial failure? | resilience |
| A1 | Architecture drift | Does the change violate the project's module boundaries? | architecture |
| S1 | Security smell | Could this be exploited, leak data, or weaken an existing control? | security |
| X1 | Cross-cutting (auto) | Findings produced by synthesis deduplication, not a primary lens | synthesis |

## Severity guide (per code)

The default severity comes from the lens. The `severity` config field lets
you *override* the default for a given code:

| Default range | Suggested override pattern |
|---|---|
| `critical` | KISS violation in a hot path → downgrade to `high` (acknowledged but not blocking) |
| `high` | Duplication in legacy code → downgrade to `low` (keep the finding but don't block) |
| `nit` | Clarity hit on a public API → upgrade to `high` (treat as blocking) |

The override only takes effect after the lens produces the finding — it's
not a pre-filter. Use `ignore` for that.
