# DRYKISS — Shared Prompt Fragments

This directory contains the *shared* parts of every lens's system prompt. They are concatenated with each per-lens `.md` file (`../<lens>.md`) at runtime to produce the final system prompt sent to the model.

## Files

| File | Purpose |
|---|---|
| `iron-law.md` | The Iron Law: "never suggest fixes before completing risk diagnosis". Loaded first. Sets the lens's epistemic stance. |
| `json-output.md` | JSON output schema for lens reviews. Loaded after the lens body. |
| `json-output-synthesis.md` | JSON output schema for the synthesis step. Loaded only when composing the synthesis prompt. |
| `grounding-rules.md` | Severity calibration and anti-noise rules for lens reviews. |
| `grounding-rules-synthesis.md` | Severity calibration for the synthesis step (stricter — filters out the cheap-model noise). |
| `kiss-dry-checklist.md` | The Quick Self-Check that asks every lens to verify KISS/DRY/names/size/etc. before flagging a finding. |
| `active-constraints.md` | A *template* with a `{{active_constraints}}` placeholder. Only loaded when the project has `disable`/`focus`/`ignore`/`severity` config set. The composer substitutes the runtime constraint list into the placeholder. |
| `README.md` | This file. |

## Composition order (lens)

```
iron-law.md
<lens>.md
active-constraints.md  (only if config has active constraints)
json-output.md
grounding-rules.md
kiss-dry-checklist.md
```

## Composition order (synthesis)

```
iron-law.md  (synthesis also operates under the Iron Law)
synthesis.md
active-constraints.md  (only if config has active constraints)
json-output-synthesis.md
grounding-rules-synthesis.md
```

## Editing

These files are part of the DRYKISS repo. Edit them like any source file: PR, review, merge. The CI check `npm run check:no-prompt-literals` will fail if any prompt text leaks into a TypeScript file.
