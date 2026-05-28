# pi-drykiss

Code reviews shouldn't be a checkbox. They should catch the things that actually matter — unnecessary complexity, duplicated logic, silent failures, and security holes.

`pi-drykiss` runs seven independent AI reviewers in parallel, each focused on a specific aspect of code quality. They don't see each other's work until synthesis, preventing groupthink and keeping findings honest. Results are ranked by severity and cross-validated before you see them.

> _"Use AI to write better code, more slowly."_ — Inspired by [Nolan Lawson](https://nolanlawson.com/2026/05/25/using-ai-to-write-better-code-more-slowly/)

## Quick Start

```bash
pi install npm:pi-drykiss
```

Then run:

```
/drykiss
```

That's it. Seven reviewers will analyze your changes and give you a ranked report.

## What Gets Reviewed

Each lens focuses on one thing:

| Lens | What It Catches |
|------|-----------------|
| **Simplicity** | Over-engineering, unnecessary abstraction, "clever" one-liners, deep nesting |
| **Deduplication** | Copy-pasted logic, magic values, scattered conditionals, cross-file duplication |
| **Clarity** | Unclear names, missing edge cases, performance issues (N+1 queries, XSS) |
| **Resilience** | Swallowed exceptions, unhandled promise rejections, generic error messages |
| **Architecture** | SRP violations, wide interfaces, circular dependencies, removal candidates |
| **Tests** | Missing coverage, untested branches, fragile assertions, shared mutable state |
| **Security** | Injection vulnerabilities, hardcoded credentials, missing auth checks |

## Commands

```
/drykiss                    # review all uncommitted changes
/drykiss --staged           # review staged changes only
/drykiss --ref=main         # diff against main
/drykiss src/foo.ts         # review specific files
/drykiss --model=haiku      # use a specific model
```

**Focused reviews:**

```
/drykiss-kiss              # simplicity only
/drykiss-dry               # duplication only
/drykiss-resilience        # error handling only
/drykiss-arch              # architecture only
/drykiss-tests             # test coverage only
```

**Configuration:**

```
/drykiss-config                           # show current config
/drykiss-config set-default sonnet        # set default model
/drykiss-config set-lens clarity sonnet   # per-lens model override
/drykiss-config confirm off               # skip confirmation dialog
/drykiss-config context-mode diff         # review diffs only (faster)
/drykiss-config reset-prompts             # regenerate default prompts
```

**History:**

```
/drykiss-history             # browse past reviews
/drykiss-jobs                # inspect running/completed reviews
```

## Why Full-File Context?

Most code review tools only see the diff. `pi-drykiss` reviewers see the **entire file** plus the diff. This means they can:

- Spot existing helpers you already have 50 lines up
- Judge whether new code follows existing patterns
- Catch imports that duplicate what's already there

The DRY and Architecture reviewers also get a **project index** — a map of exported functions across your codebase — so they can catch cross-file duplication.

## Customizable Prompts

Every reviewer's system prompt is an editable Markdown file at `~/.pi/drykiss/prompts/`. Edit them to:

- Add company-specific conventions
- Adjust severity thresholds
- Add custom checklists

The JSON output format is always appended by code, so you can't accidentally break parsing.

## Model Selection

Models are resolved in this order:

1. `--model` CLI flag
2. Per-lens config (`/drykiss-config set-lens ...`)
3. Global default (`/drykiss-config set-default ...`)
4. Interactive picker (on first use, saved automatically)
5. First available model

If a model hits a quota limit, you'll be prompted to pick a different one and the review retries automatically.

## Severity Levels

| Level | Meaning |
|-------|---------|
| **Critical** | Security vulnerability, data loss, broken functionality |
| **High** | Significant maintainability or performance impact |
| **Medium** | Clear improvement worth making |
| **Low** | Nice-to-have or stylistic |
| **Nit** | Very minor |

## Inspiration

- [Nolan Lawson — Using AI to write better code more slowly](https://nolanlawson.com/2026/05/25/using-ai-to-write-better-code-more-slowly/)
- [Karpathy Guidelines — Reducing LLM coding mistakes](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md)
- [KISS principle](https://en.wikipedia.org/wiki/KISS_principle)
- [DRY principle](https://en.wikipedia.org/wiki/Don%27t_repeat_yourself)

## License

MIT
