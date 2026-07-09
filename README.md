# pi-drykiss

pi-drykiss is a Pi extension for multi-lens AI code review.

It runs focused reviewers in parallel, then synthesizes their findings into one
ranked report. The goal is high-signal review feedback: simpler code, less
duplication, stronger error handling, better tests, safer boundaries, and docs
that match reality.

## What It Does

- Reviews git diffs, commits, branches, PRs, explicit files, or the full codebase
- Runs independent lenses for simplicity, duplication, clarity, resilience,
  architecture, tests, security, and docs
- Gives reviewers full-file context, not just diff hunks
- Uses a project index where useful for cross-file duplication/architecture checks
- Deduplicates and ranks findings during synthesis
- Persists reports and lens session logs under `~/.pi/drykiss/`
- Supports project config, prompt customization, model fallback, and free-model
  autorouting

## Install

```bash
pi install npm:pi-drykiss
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-drykiss
```

## Usage

Ask Pi to run an autoreview, or call the `drykiss_autoreview` tool directly.

Common scopes:

```text
drykiss_autoreview mode=local              # uncommitted changes
drykiss_autoreview mode=staged             # staged changes
drykiss_autoreview mode=branch base=main   # branch diff
drykiss_autoreview mode=commit commit=HEAD # one commit
drykiss_autoreview mode=files files=[...]  # selected files
drykiss_autoreview mode=full               # whole codebase
```

Useful options:

```text
lens=security              # one focused lens
lenses=[simplicity,tests]  # selected lenses
format=structured          # full structured report
```

Model selection, context mode, max files, validation, prompt overrides, and
risk-targeting are config-driven via `.pi/drykiss/config.json` and
`~/.pi/drykiss/config.json`.

## Lenses

- **Simplicity** — unnecessary complexity and speculative abstractions
- **Deduplication** — repeated logic, rules, constants, and validation
- **Clarity** — readability, correctness, stale comments, conventions, a11y
- **Resilience** — swallowed errors, weak fallbacks, missing failure signals
- **Architecture** — boundaries, seams, dependency direction, type design
- **Tests** — missing behaviors, weak assertions, brittle coverage
- **Security** — injection, auth, secrets, data exposure, crypto, supply chain
- **Docs** — README/CHANGELOG/AGENTS drift against actual code/config

## Prompts

All prompt text lives in Markdown files.

Resolution order:

1. `DRYKISS_PROMPTS_DIR`
2. `~/.pi/drykiss/prompts/`
3. bundled `src/prompts/`

Edit the seeded files in `~/.pi/drykiss/prompts/` to tune lens behavior for your
project without changing TypeScript code.

## Documentation

- [Autoreview inspiration](docs/autoreview-inspiration.md) — researched ideas and
  possible future improvements

## Development

```bash
npm test
npm run typecheck
npm run check:no-prompt-literals
npm run check
```

Important project rule: prompt bodies belong in `.md` files, not TypeScript
string literals.

## License

MIT
