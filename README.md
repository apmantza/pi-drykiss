# pi-drykiss

A [Pi](https://github.com/nicholasgasior/pi-coding-agent) extension that reviews code changes through focused, clear-context reviewer subagents adhering to **KISS** (Keep It Simple, Stupid) and **DRY** (Don't Repeat Yourself) principles.

> _"Use AI to write better code, more slowly."_ — Inspired by [Nolan Lawson](https://nolanlawson.com/2026/05/25/using-ai-to-write-better-code-more-slowly/)

## Philosophy

Most AI coding tools optimize for speed and volume. `pi-drykiss` optimizes for **quality and maintainability**:

- **Clear context**: Each reviewer subagent gets a single, focused lens — they don't see each other's work until synthesis
- **Full file context**: Reviewers see the complete file, not just changed hunks, so they can spot "you already have a helper for this 50 lines up"
- **Project-wide DRY**: The duplication hunter gets an index of existing modules and exports across the codebase
- **Structured output**: Subagents emit JSON findings, not prose — programmatically accessible, persistable, tool-callable
- **No false positives**: Findings are cross-validated across lenses before being reported
- **Ranked by severity**: Critical > High > Medium > Low > Nit — triage what matters
- **Model flexibility**: Choose different models per lens, fallback on quota errors, configure defaults
- **Customizable prompts**: Every reviewer system prompt is an editable `.md` file
- **Zero-cost auto-review**: A lightweight KISS/DRY checklist is injected into the system prompt after every editing turn

### Design Influences

- **Nolan Lawson** — slow down, review more, ship better code
- **Karpathy Guidelines** — surgical changes only, no speculative features, minimum viable code, clean up your own mess
- **Anthropic PR Review Toolkit** — dedicated silent-failure hunting, type design analysis
- **Sanyuan Code Review Expert** — SOLID violations, removal candidates, race conditions

## Installation

```bash
pi install npm:pi-drykiss
```

## Commands

### `/drykiss` — Full multi-lens review

```
/drykiss                    # review all uncommitted changes
/drykiss --staged           # review staged changes only
/drykiss --ref=main         # diff against main
/drykiss --model=haiku      # use a specific model
/drykiss src/foo.ts         # review specific files
```

Runs five independent reviewer subagents in **parallel**, each with an isolated context window:

1. **Simplicity (KISS)** — unnecessary complexity, premature abstraction, over-engineering, Chesterton's Fence, speculative features, surgical-change violations
2. **Deduplication (DRY)** — repeated logic, magic values, copy-paste, scattered knowledge. Sees a project index of existing utilities so it can spot cross-file duplication.
3. **Clarity & Quality** — naming, correctness, security, performance (N+1 queries, XSS, SQL injection, etc.)
4. **Resilience** — error handling, silent failures, swallowed exceptions, overly broad catch blocks, missing async error handling
5. **Architecture** — SOLID principles, type design, dependency direction, removal candidates, goal-driven execution checks

Then a synthesizer deduplicates, ranks by severity, assigns confidence, and produces a final verdict.

### Focused lens reviews

```
/drykiss-kiss              # KISS-only review
/drykiss-dry               # DRY-only review
/drykiss-resilience        # Error handling only
/drykiss-arch              # Architecture / SOLID only
```

All support `--model=sonnet` and other flags.

### `/drykiss-config` — Configure defaults

```
/drykiss-config                           # show current config
/drykiss-config set-default sonnet        # set global default model
/drykiss-config set-lens clarity sonnet   # per-lens override
/drykiss-config interactive off           # disable model picker
/drykiss-config confirm off               # skip confirmation dialog
/drykiss-config context-mode diff         # review diffs only (faster, less context)
/drykiss-config context-mode full         # review full files + project index (default)
/drykiss-config reset-prompts             # regenerate default prompt templates
```

Config is persisted to `.pi/drykiss/config.json`:

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "lensModels": {
    "simplicity": "haiku",
    "deduplication": "haiku",
    "clarity": "sonnet",
    "resilience": "sonnet",
    "architecture": "sonnet",
    "synthesis": "sonnet"
  },
  "interactive": true,
  "confirmBeforeRun": true,
  "contextMode": "full"
}
```

### `/drykiss-history` — Browse past reviews

```
/drykiss-history
```

Shows persisted reviews from `.pi/drykiss/reviews/*.json`.

## Tool: `drykiss_review`

The LLM can call this tool directly:

```typescript
drykiss_review({
  lens: "simplicity",
  files: ["src/api.ts", "src/auth.ts"],
  model: "haiku"  // optional
})
```

Returns structured JSON findings.

## Model Selection

**Priority order** (highest to lowest):

1. `--model=sonnet` CLI flag
2. `lensModels.simplicity` per-lens config
3. `defaultModel` global config
4. Interactive popup picker (on first use, saved to config)
5. First available model

**Quota/rate-limit recovery**: If a model hits a quota or rate limit, the user is prompted to pick a different model and the review retries automatically.

## Review Context

By default, reviewers see the **full file content** plus the **diff**, not just changed hunks. This means they can:

- Spot existing helpers, types, and utilities already defined in the same file
- Judge whether new code follows existing patterns in the file
- Catch imports that duplicate existing ones

The DRY and Architecture reviewers also receive a **project index** — a lightweight map of exported functions, classes, and constants across the codebase — so they can spot cross-file duplication and structural inconsistencies.

Files longer than 500 lines are truncated. If you prefer diff-only mode (faster, fewer tokens):

```
/drykiss-config context-mode diff
```

## Customizable Prompts

Every reviewer system prompt is stored as an editable Markdown file:

```
.pi/drykiss/prompts/
  simplicity.md      # KISS reviewer instructions
  deduplication.md   # DRY reviewer instructions
  clarity.md         # Quality reviewer instructions
  resilience.md      # Error handling reviewer instructions
  architecture.md    # SOLID / type design reviewer instructions
  synthesis.md       # Final synthesis instructions
```

These are generated automatically on first run. Edit them to customize reviewer behavior — for example, add company-specific conventions, adjust severity thresholds, or add new checklists. The JSON output format is always appended by code, so you can't accidentally break parsing.

To reset to defaults:

```
/drykiss-config reset-prompts
```

## Review Lenses

| Lens | Focus | Example Findings |
|------|-------|-----------------|
| **Simplicity** | KISS + Karpathy | Unnecessary abstraction, "clever" one-liners, deep nesting, speculative features, single-use abstractions, surgical-change violations (refactoring unrelated code) |
| **Deduplication** | DRY + index | Copy-pasted blocks, magic values, parallel switch cases, scattered conditionals, duplicated config, cross-file duplication |
| **Clarity** | Quality | Unclear names, missing edge cases, SQL injection, XSS, N+1 queries, unbounded fetching, missing indexes |
| **Resilience** | Error handling | Swallowed exceptions, overly broad catch blocks, unhandled promise rejections, missing async error handling, generic error messages |
| **Architecture** | SOLID + types | SRP violations, wide interfaces, anemic domain models, circular dependencies, missing constructor validation, removal candidates, untestable changes |

## Severity Levels

| Level | Meaning | Action |
|-------|---------|--------|
| **Critical** | Security vulnerability, data loss, broken functionality | Must fix before merge |
| **High** | Significant maintainability or performance impact | Strongly recommended |
| **Medium** | Clear improvement worth making | Recommended |
| **Low** | Nice-to-have or stylistic | Optional |
| **Nit** | Very minor | Author may ignore |

## Output Format

Findings are persisted as structured JSON:

```json
{
  "timestamp": "2026-05-26T23-05-46-000Z",
  "files": ["src/api.ts", "src/auth.ts"],
  "summary": "Raw user input flows to SQL in 2 places",
  "verdict": "Needs security review",
  "criticalCount": 2,
  "highCount": 1,
  "mediumCount": 3,
  "lowCount": 0,
  "nitCount": 1,
  "findings": [
    {
      "file": "src/api.ts",
      "line": 42,
      "severity": "critical",
      "category": "SQL Injection",
      "summary": "User input concatenated into SQL query",
      "detail": "req.query.id is passed directly to db.query() without sanitization",
      "suggestion": "Use parameterized queries",
      "confidence": "confirmed"
    }
  ]
}
```

## Auto-Review After Edits

After every turn with `Write` or `Edit`, a lightweight KISS/DRY checklist is automatically injected into the system prompt before the next agent turn:

- Is the new code as simple as the problem allows?
- Is knowledge represented once?
- Do names reveal intent?
- Are functions focused on one thing?
- Do comments explain WHY, not WHAT?
- Are edge cases handled?
- Is user input validated at boundaries?

## Inspiration

- [Nolan Lawson — Using AI to write better code more slowly](https://nolanlawson.com/2026/05/25/using-ai-to-write-better-code-more-slowly/)
- [Karpathy Guidelines — Reducing LLM coding mistakes](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md)
- [KISS principle](https://en.wikipedia.org/wiki/KISS_principle)
- [DRY principle](https://en.wikipedia.org/wiki/Don%27t_repeat_yourself)

## License

MIT
