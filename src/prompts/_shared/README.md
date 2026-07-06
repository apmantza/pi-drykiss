# DRYKISS — Shared Prompt Fragments

This directory contains the *shared* parts of every lens's system prompt. They are concatenated with each per-lens `.md` file (`../<lens>.md`) at runtime to produce the final system prompt sent to the model.

## Files

| File | Purpose |
|---|---|
| `iron-law.md` | The Iron Law: "never suggest fixes before completing risk diagnosis". Loaded first. Sets the lens's epistemic stance. |
| `json-output.md` | JSON output schema for lens reviews. Loaded after the lens body. |
| `json-output-synthesis.md` | JSON output schema for the synthesis step. Loaded only when composing the synthesis prompt. |
| `grounding-rules.md` | Severity calibration, anti-noise, and a "Quick Self-Check" (KISS/DRY/names/size/edge-cases/security/resilience/architecture) for lens reviews, plus a "Synthesis Calibration" section with the stricter final-filter rules for the synthesis step. Shared by both lens and synthesis prompts. |
| `active-constraints.md` | A *template* with a `{{active_constraints}}` placeholder. Only loaded when the project has `disable`/`focus`/`ignore`/`severity` config set. The composer substitutes the runtime constraint list into the placeholder. |
| `mode-context-proposed.md` | Injected into the lens **user** prompt when the review mode is a proposed change (local/staged/branch/commit/pr/files). Frames the reviewer as gating a change set. Loaded by `mode-context.ts`. |
| `mode-context-audit.md` | Injected into the lens **user** prompt when the review mode is a full-codebase audit. Frames the reviewer to skip diff-introduced vs pre-existing checks. Loaded by `mode-context.ts`. |
| `validator.md` | System prompt for the optional adversarial validator pass (fail-open). Loaded by `validator.ts`. |
| `pass-system.md` | System prompt for the deep (multi-pass) review passes. Loaded by `deep-review.ts`. |
| `focuses.md` | Numbered per-pass focus seeds for the deep review rotation. Loaded by `deep-review.ts`. |
| `risk-codes.md` | Human-readable catalogue of the DRYKISS + brooks-lint risk codes (with frontmatter). Referenced from `risk-codes.ts`; not loaded as a model prompt. |
| `README.md` | This file. |

## Composition order (lens)

```
iron-law.md
<lens>.md
active-constraints.md  (only if config has active constraints)
json-output.md
grounding-rules.md
```

## Composition order (synthesis)

```
iron-law.md  (synthesis also operates under the Iron Law)
synthesis.md
active-constraints.md  (only if config has active constraints)
json-output-synthesis.md
grounding-rules.md
```

## Editing

These files are part of the DRYKISS repo. Edit them like any source file: PR, review, merge. The CI check `npm run check:no-prompt-literals` will fail if any prompt text leaks into a TypeScript file.
