# pi-drykiss

A [Pi](https://github.com/nicholasgasior/pi-coding-agent) extension that reviews code changes through focused, clear-context reviewer subagents adhering to **KISS** (Keep It Simple, Stupid) and **DRY** (Don't Repeat Yourself) principles.

> _"Use AI to write better code, more slowly."_ — Inspired by [Nolan Lawson](https://nolanlawson.com/2026/05/25/using-ai-to-write-better-code-more-slowly/)

## Philosophy

Most AI coding tools optimize for speed and volume. `pi-drykiss` optimizes for **quality and maintainability**:

- **Clear context**: Each reviewer subagent gets a single, focused lens — they don't see each other's work until synthesis
- **Structured output**: Subagents emit JSON findings, not prose — programmatically accessible, persistable, tool-callable
- **No false positives**: Findings are cross-validated across lenses before being reported
- **Ranked by severity**: Critical > High > Medium > Low > Nit — triage what matters
- **Model flexibility**: Choose different models per lens, fallback on quota errors, configure defaults
- **Zero-cost auto-review**: A lightweight KISS/DRY checklist is injected into the system prompt after every editing turn

## Installation

```bash
pi install npm:pi-drykiss
```

Or load directly:

```bash
pi -e ./src/index.ts
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

Runs three independent reviewer subagents in **parallel**, each with an isolated context window:

1. **Simplicity (KISS)** — unnecessary complexity, premature abstraction, over-engineering, Chesterton's Fence
2. **Deduplication (DRY)** — repeated logic, magic values, copy-paste, scattered knowledge
3. **Clarity & Quality** — naming, correctness, architecture, security, performance (N+1 queries, XSS, SQL injection, etc.)

Then a synthesizer deduplicates, ranks by severity, assigns confidence, and produces a final verdict.

### `/drykiss-kiss` — Focused simplicity review

```
/drykiss-kiss
/drykiss-kiss --model=sonnet
```

### `/drykiss-dry` — Focused duplication review

```
/drykiss-dry
/drykiss-dry --model=haiku
```

### `/drykiss-config` — Configure defaults

```
/drykiss-config                           # show current config
/drykiss-config set-default sonnet        # set global default model
/drykiss-config set-lens clarity sonnet   # per-lens override
/drykiss-config interactive off           # disable model picker
/drykiss-config confirm off               # skip confirmation dialog
```

Config is persisted to `.pi/drykiss/config.json`:

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "lensModels": {
    "simplicity": "haiku",
    "deduplication": "haiku",
    "clarity": "sonnet",
    "synthesis": "sonnet"
  },
  "interactive": true,
  "confirmBeforeRun": true
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

## Review Lenses

| Lens | Focus | Example Findings |
|------|-------|-----------------|
| **Simplicity** | KISS | Unnecessary abstraction, "clever" one-liners, deep nesting, long functions, dead code, Chesterton's Fence violations |
| **Deduplication** | DRY | Copy-pasted blocks, magic values, parallel switch cases, scattered conditionals, duplicated config |
| **Clarity** | Quality | Unclear names, missing edge cases, SQL injection, XSS, N+1 queries, unbounded fetching, missing indexes |

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
- [KISS principle](https://en.wikipedia.org/wiki/KISS_principle)
- [DRY principle](https://en.wikipedia.org/wiki/Don%27t_repeat_yourself)

## License

MIT
