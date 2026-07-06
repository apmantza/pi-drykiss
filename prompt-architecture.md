# DRYKISS — Prompt Architecture Constraint

This is a hard constraint that governs every change to DRYKISS's prompt text:

> **All prompt text MUST live in `.md` files. TypeScript modules MUST NOT contain prompt text as string literals.**

This applies to:

- The system prompt for each lens (simplicity, deduplication, clarity, resilience, architecture, tests, security, synthesis)
- The shared framework text (Iron Law, Report Template, Health Score, KISS/DRY checklist, JSON output instructions, grounding rules)
- Per-lens overlays (severity calibration, "do not flag" clauses, examples)
- The synthesis prompt

The TypeScript prompt code may:

- Read `.md` files from disk (`readFile`)
- Concatenate strings (compose a prompt from multiple `.md` fragments)
- Substitute variables (insert active constraints, file paths, etc.)
- Bundle the seed `.md` files into the published npm package (via `package.json::files` and a build step)
- Run the first-use seed from the bundled `.md` files into `~/.pi/drykiss/prompts/`

The TypeScript prompt code may NOT:

- Contain a backtick-delimited template literal that is a sentence or paragraph of English instructions to a model
- Contain a hardcoded prompt body as a `const x = "..."` or `const x = \`...\``
- Reference `DEFAULT_*_PROMPT` as a TS-exported constant string
- Import prompt text from any TS module — only from `.md` files

## Why this constraint exists

1. **Editability.** Prompt authors (humans, including the DRYKISS maintainer) should edit prompts with a normal markdown editor, with the full power of editor preview, linting, and git diff. Editing a `.ts` string literal requires recompiling and re-running tests, and the diff is unreadable.
2. **User ownership.** The whole point of the `~/.pi/drykiss/prompts/` directory is that users can override per-lens prompts. If the TS file is the source of truth, the override is fragile: any new release silently overwrites the user's edits unless the seed is gated by a sentinel. With `.md` files inside the repo, the "bundled default" is a real artifact the user can read, diff, and selectively carry forward.
3. **Discoverability.** `src/prompts/simplicity.md` is the canonical "what is the simplicity lens?" answer. `src/prompt-builder.ts` having a 100-line `simplicity: \`...\`` is opaque.
4. **Testability.** A prompt-compliance test can assert that the `.md` file contains required substrings (Iron Law, JSON output format, severity labels) without parsing TypeScript template literals.
5. **Triage.** When a user reports a bad review, the first thing to inspect is the prompt they were running. A `.md` file at a known path is greppable; a TypeScript template literal in a 700-line file is not.
6. **Consistency with brooks-lint.** brooks-lint's `skills/_shared/*.md` and `skills/<lens>/SKILL.md` are all `.md`. There's no "default prompt" in a TypeScript file. The brooks-lint pattern is what we're aligning to.

## Concrete layout (target)

```
pi-drykiss/
├── src/
│   ├── prompts/                     # Bundled defaults — the source of truth
│   │   ├── _shared/
│   │   │   ├── iron-law.md          # "NEVER suggest fixes before completing risk diagnosis..."
│   │   │   ├── json-output.md       # JSON output instructions for lens prompts
│   │   │   ├── json-output-synthesis.md  # JSON output instructions for synthesis
│   │   │   ├── grounding-rules.md   # Severity calibration + Quick Self-Check (merged from kiss-dry-checklist) + Synthesis Calibration (merged from grounding-rules-synthesis)
│   │   │   ├── active-constraints.md  # Placeholder for the disable/severity/ignore/focus block
│   │   │   ├── mode-context-proposed.md  # Proposed-change framing (injected into lens user prompt)
│   │   │   ├── mode-context-audit.md      # Full-codebase audit framing (injected into lens user prompt)
│   │   │   ├── validator.md        # Optional adversarial validator pass prompt
│   │   │   ├── pass-system.md       # Deep (multi-pass) review system prompt
│   │   │   ├── focuses.md           # Per-pass focus seeds for deep review rotation
│   │   │   ├── risk-codes.md        # Human-readable risk-code catalogue (not a model prompt)
│   │   │   └── README.md            # What each file is for
│   │   ├── simplicity.md
│   │   ├── deduplication.md
│   │   ├── clarity.md
│   │   ├── resilience.md
│   │   ├── architecture.md
│   │   ├── tests.md
│   │   ├── security.md
│   │   └── synthesis.md
│   ├── prompt-loader.ts             # Reads .md files from a directory, composes a system prompt
│   ├── prompt-composer.ts           # Combines _shared/* + <lens>.md into the final prompt
│   ├── prompt-seed.ts               # Copies src/prompts/ to ~/.pi/drykiss/prompts/ on first run
│   ├── prompt-builder.ts            # Orchestrates loadLensSystemPrompt, loadSynthesisSystemPrompt,
│   │                                 #   buildReviewPrompts, buildSynthesisPrompt (was the
│   │                                 #   790-line god module; now thin and prompt-free)
│   └── ...
├── scripts/
│   └── check-no-prompt-literals.ts  # Fails the build if any .ts file contains prompt text
└── ...
```

## What changes vs the current state

| Today | Target |
|---|---|
| `src/default_prompts.ts` (415 lines of TS string literals) | `src/prompts/*.md` (8 lens files + 1 synthesis + shared dir) |
| `src/prompt-builder.ts` has inline `DEFAULT_LENS_PROMPTS`, `DEFAULT_SYNTHESIS_PROMPT`, `JSON_OUTPUT_INSTRUCTIONS`, `SYNTHESIS_JSON_INSTRUCTIONS`, `REVIEW_GROUNDING_RULES`, `SYNTHESIS_GROUNDING_RULES`, `KISS_DRY_CHECKLIST` (totalling ~700 lines of prompt text) | `src/prompt-builder.ts` is purely orchestration; prompt text exists only as `.md` |
| `loadPromptBody` reads from `~/.pi/drykiss/prompts/<lens>.md`, falls back to the TS constant | `loadPromptBody` reads from the configured prompts dir (with env override), falls back to the bundled `.md` files via `readFile(new URL("./prompts/<lens>.md", import.meta.url), "utf8")` |
| First-use seed copies TS constants to `~/.pi/drykiss/prompts/` | First-use seed copies bundled `.md` files to `~/.pi/drykiss/prompts/` via a manifest |
| Tests assert substrings in TS template literals | Tests assert file presence + content |
| No automation prevents re-introducing TS prompt text | `scripts/check-no-prompt-literals.ts` runs in CI and fails the build |

## How prompts get bundled into the npm package

Two options. The second is preferred.

### Option A: `package.json::files` whitelist

```json
{
  "files": ["dist/", "src/prompts/"]
}
```

Since the prompt files are at a stable path and the loader uses `new URL(..., import.meta.url)`, jiti's loader resolves them at runtime. This is the brooks-lint approach (the skill files are bundled in the plugin's `skills/` directory and the plugin manifest points at them).

### Option B: Build-time copy

A `prebuild` script copies `src/prompts/` to `dist/prompts/`. The loader uses `import.meta.url` to find the right path. More moving parts, but works better when the `.ts` files get compiled.

**Recommendation: Option A for v1.** It matches brooks-lint's pattern and is simpler. If we hit issues with jiti not resolving `import.meta.url` cleanly on Windows, switch to Option B.

## The CI check

`scripts/check-no-prompt-literals.ts` runs as part of `npm run check` (and in CI). It scans every `.ts` file in `src/` (excluding `*.test.ts`) for patterns that indicate a prompt is hardcoded:

```ts
// Heuristic rules — all are slightly imprecise, so report but don't fail
// on the first match; require a confidence score.

// 1. A backtick-delimited template literal >200 characters
const t = /`(?:[^`\\]|\\.){200,}`/g;

// 2. A double-quoted string >200 characters
const dq = /"(?:[^"\\]|\\.){200,}"/g;

// 3. The names "DEFAULT_*_PROMPT" or "*_PROMPT_BODY" appearing in any file
const names = /\b(DEFAULT_[A-Z_]*PROMPT|[A-Z_]*PROMPT_BODY)\b/g;
```

Files that legitimately contain long strings (like a single-line licence header, or a base64-encoded test fixture) are whitelisted in the script. The check prints a clear error: `"src/foo.ts contains a 1247-char template literal on line 42. Move this to src/prompts/<lens>.md and load it via promptLoader()."` and exits non-zero.

The check is best-effort: heuristics can be evaded. But it raises the cost of regression significantly — anyone re-introducing a TS prompt has to know they're doing it and bypass the check.

## The prompt-loader.ts API

```ts
// src/prompt-loader.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PromptSource {
  /** Where to read prompts from. Defaults to bundled defaults. */
  readonly dir: string;
}

export async function loadPromptFile(
  source: PromptSource,
  name: string,
): Promise<string> {
  const path = join(source.dir, `${name}.md`);
  return readFile(path, "utf8");
}

export async function loadSharedFragment(
  source: PromptSource,
  name: string,
): Promise<string> {
  return loadPromptFile({ ...source, dir: join(source.dir, "_shared") }, name);
}
```

`source.dir` resolves in this order:

1. `process.env.DRYKISS_PROMPTS_DIR` (debug override)
2. `~/.pi/drykiss/prompts/` (user-customized)
3. Bundled `src/prompts/` (the fallback resolved via `new URL("./prompts/", import.meta.url)`)

## The prompt-composer.ts API

```ts
// src/prompt-composer.ts
import { loadPromptBody } from "./prompt-loader.js";

export interface ComposeOptions {
  readonly activeConstraints?: string;  // Injected disable/severity/ignore/focus block
}

export async function composeLensPrompt(
  lens: Exclude<ReviewLens, "all">,
  options: ComposeOptions,
): Promise<string> {
  const [ironLaw, lensBody, jsonOutput, grounding, activeTemplate] =
    await Promise.all([
      loadPromptBody("iron-law", "shared"),
      loadPromptBody(lens, "lens"),
      loadPromptBody("json-output", "shared"),
      loadPromptBody("grounding-rules", "shared"),
      options.activeConstraints
        ? loadPromptBody("active-constraints", "shared")
        : Promise.resolve(""),
    ]);

  const sections = [ironLaw, lensBody];
  if (activeTemplate && options.activeConstraints) {
    sections.push(
      substitute(activeTemplate, {
        active_constraints: options.activeConstraints,
      }),
    );
  }
  sections.push(jsonOutput, grounding);

  return sections.filter(Boolean).join("\n\n");
}

export async function composeSynthesisPrompt(
  options: ComposeOptions,
): Promise<string> {
  // analogous, using synthesis-specific shared fragments
}
```

## The prompt-builder.ts API (the thin orchestrator)

```ts
// src/prompt-builder.ts (after refactor — should be ~150 lines, not 790)
import { composeLensPrompt, composeSynthesisPrompt, defaultPromptSource } from "./prompt-composer.js";
import { getGlobalPromptsDir } from "./constants.js";

export async function loadLensSystemPrompt(
  lens: Exclude<ReviewLens, "all">,
  activeConstraints?: string,
): Promise<string> {
  const source = { dir: getGlobalPromptsDir() };
  return composeLensPrompt(lens, { source, activeConstraints });
}

export async function loadSynthesisSystemPrompt(): Promise<string> {
  const source = { dir: getGlobalPromptsDir() };
  return composeSynthesisPrompt({ source });
}

export function bundledPromptsDir(): string {
  // Resolves to src/prompts/ via new URL at runtime
  return new URL("../prompts/", import.meta.url).pathname;
}

export async function ensureDefaultPrompts(): Promise<void> {
  const userDir = getGlobalPromptsDir();
  // Copy bundled src/prompts/* to userDir on first run
  // (sentinel-versioned per P0.2)
}
```

## The migration (one-time)

The migration is itself a refactor item — see `refactorplan.md` §2 under "P0.4 — Move prompts from .ts to .md".

Summary: take the 7 lens prompt bodies, the synthesis prompt, and the 5 shared fragments currently in TS, write each to its own `.md` file under `src/prompts/`, replace the TS constants with `readFile` calls, add the CI check, delete the TS string literals, run the tests.

## What this constraint does NOT change

- The user-facing API of `/drykiss` commands
- The structure of the `Finding` interface
- The synthesis flow
- The widget rendering
- The config model

It only changes where prompt text physically lives, and adds a CI guard against regression.

## When in doubt

If you're about to add a string literal longer than a single short sentence to a `.ts` file, stop. Ask: is this a prompt? If yes, write it to `src/prompts/<something>.md` instead. If no (e.g., an error message, a log line, a user-facing notification), proceed — the constraint is about prompt text, not all long strings.
