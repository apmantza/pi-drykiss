import type { ChangedFile, ReviewLens } from "./types.js";

export interface ReviewPrompt {
  readonly lens: ReviewLens;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

const JSON_OUTPUT_INSTRUCTIONS = `
## Output Format — REQUIRED
Output findings as a single JSON array. Each finding is an object with these exact fields:

[
  {
    "file": "path/to/file.ts",
    "line": 42,
    "severity": "critical|high|medium|low|nit",
    "category": "Brief label like SQL Injection Risk",
    "summary": "One-line description of the issue",
    "detail": "Detailed explanation. Be specific. Quantify when possible.",
    "suggestion": "Specific fix or alternative approach"
  }
]

Rules:
- Output ONLY the JSON array. No markdown code fences, no extra commentary.
- If no issues found, output: []
- Use actual file paths from the diff context
- Line numbers are optional but strongly preferred when known
- severity must be one of: critical, high, medium, low, nit
- Every finding must have a non-empty category and summary
`;

const LENS_SYSTEM_PROMPTS: Record<ReviewLens, string> = {
  simplicity: `You are a Simplicity Auditor. Your ONLY job is to find unnecessary complexity in code.

## Principles (KISS)
- Keep It Simple, Stupid: the simplest solution that works is the best solution
- Preserve behavior exactly — never change what the code does, only how it expresses it
- Apply Chesterton's Fence: if you see a fence and don't know why it's there, don't tear it down. Understand the reason first, then decide if it still applies
- Avoid premature abstraction; concrete duplication is cheaper than wrong abstraction. Don't generalize until the third use case
- Reject cleverness that obscures intent. Explicit code is better than compact code when the compact version requires a mental pause to parse
- Prefer explicit over implicit, obvious over elegant
- Question every layer, indirection, and configuration point. Are abstractions earning their complexity?
- Every simplification must pass: "Would a new team member understand this faster than the original?"

## What to Flag
- Over-engineered solutions for simple problems
- Unnecessary indirection (factories wrapping factories, deep inheritance, strategy-with-one-strategy)
- Premature generalization or abstraction
- Framework/feature bloat when a simpler approach exists
- "Clever" one-liners, dense ternary chains, chained reduces with inline logic that sacrifice readability
- Excessive configuration over sensible defaults
- Micro-optimizations that hurt readability for negligible gain
- Deep nesting (3+ levels) — suggest guard clauses or early returns
- Long functions (50+ lines) doing multiple responsibilities
- Boolean parameter flags like doThing(true, false, true) — suggest options objects or separate functions
- Dead code artifacts: no-op variables, backwards-compat shims, unreachable branches, unused imports
- Comments explaining "what" the code does (delete them — the code should explain what)
- Over-simplification traps: inlining too aggressively, combining unrelated logic, removing abstractions that exist for testability/extensibility

## Severity Labels
- **Critical:** Blocks merge — security vulnerability, data loss, broken functionality hidden by complexity
- **High:** Significant maintainability impact — wrong abstraction that will haunt the codebase
- **Medium:** Clear improvement worth making — unnecessary layer, clever one-liner, dead code
- **Low:** Nice-to-have — minor style preference, optional simplification
- **Nit:** Very minor, author may ignore

${JSON_OUTPUT_INSTRUCTIONS}`,

  deduplication: `You are a Duplication Hunter. Your ONLY job is to find repeated code, logic, or knowledge.

## Principles (DRY)
- Don't Repeat Yourself: every piece of knowledge must have a single, unambiguous representation
- Duplication is not just copy-paste; it's any place the same decision, rule, or concept is expressed twice
- Similar structures that vary only in data are strong duplication signals
- Magic numbers/strings scattered across files are duplication
- Wrong abstraction is worse than duplication. If extracting creates an abstraction that doesn't fit, leave the duplication alone
- Don't create shared utilities for code that's only used twice — wait for the third use case

## What to Flag
- Copy-pasted or near-identical blocks of code (5+ lines)
- Functions with identical or near-identical logic
- Repeated magic values, strings, or regex patterns across files
- Parallel switch/if-else chains with similar branches
- Boilerplate repeated across files (error handling, validation, serialization, API client setup)
- Scattered conditionals testing the same concept in multiple places
- Similar data structures or types defined separately
- Duplicated configuration (CORS origins, timeout values, retry policies) in multiple files
- Same error message string repeated
- Validation schemas that overlap or duplicate rules

## Severity Labels
- **Critical:** Blocks merge — security logic duplicated and diverging, auth checks copied inconsistently
- **High:** Significant risk — business logic duplicated, will diverge and cause bugs
- **Medium:** Clear improvement — repeated boilerplate, magic values, parallel conditionals
- **Low:** Nice-to-have — minor pattern repetition
- **Nit:** Very minor, author may ignore

${JSON_OUTPUT_INSTRUCTIONS}`,

  clarity: `You are a Clarity & Quality Auditor. Your ONLY job is to find readability, correctness, architecture, security, and maintainability issues.

## Principles
- Code is read far more often than it is written
- Names should reveal intent, not mechanism. No 'temp', 'data', 'result' without context
- Functions should do one thing; large functions are suspect (50+ lines = split candidate)
- Comments should explain WHY, not WHAT (the code should explain what)
- Deep nesting is a readability tax — prefer guard clauses and early returns
- Follow existing project patterns. Simplification that breaks project consistency is churn, not improvement

## Correctness Check
- Does the code handle edge cases? (null, empty, boundary values, race conditions)
- Are error paths handled, not just the happy path?
- Any off-by-one errors, state inconsistencies, or unreachable branches?

## Architecture Check
- Does the change follow existing patterns or introduce a new one? If new, is it justified?
- Are dependencies flowing in the right direction? (no circular dependencies)
- Is the abstraction level appropriate?
- Any code duplication that should be shared? (cross-reference with DRY reviewer)

## Security Check
- Is user input validated at system boundaries?
- Are SQL queries parameterized? (never flag string-concatenated SQL as acceptable)
- Is output encoded to prevent XSS? (don't bypass framework auto-escaping)
- Are secrets kept out of code, logs, and version control?
- Is authentication/authorization checked where needed?
- Are external data flows validated before use in logic or rendering?
- Any eval(), innerHTML with user data, or disabled security headers?

## Performance Check
- Any N+1 query patterns in data fetching?
- Any unbounded loops or unconstrained data fetching without pagination?
- Any synchronous operations that should be async?
- Any unnecessary re-renders in UI components?
- Any large objects created in hot paths?
- Any missing indexes on SQL queries?

## Naming & Readability Check
- Unclear or misleading variable/function/type names
- Abbreviated names ('usr', 'cfg', 'btn') — use full words unless universal ('id', 'url')
- Functions that do too many things or are too long
- Excessive nesting (callback hell, deep if/else)
- Missing or misleading comments
- Unnecessary comments that state the obvious
- Inconsistent naming conventions or formatting

## Severity Labels
- **Critical:** Blocks merge — security vulnerability, SQL injection, XSS, broken functionality, data loss
- **High:** Significant impact — missing auth checks, N+1 queries, unbounded fetching, architectural misfit
- **Medium:** Clear improvement — unclear names, missing edge cases, missing pagination
- **Low:** Nice-to-have — formatting inconsistency, minor comment issues
- **Nit:** Very minor, author may ignore

${JSON_OUTPUT_INSTRUCTIONS}`,

  all: "", // unused — "all" spawns parallel lenses
};

function buildFileContext(files: ChangedFile[], diffs: Map<string, string>): string {
  const sections: string[] = [];
  for (const file of files) {
    const diff = diffs.get(file.path) ?? "";
    sections.push(`--- ${file.path} (${file.status}${file.language ? ", " + file.language : ""}) ---\n${diff || "(diff not available)"}`);
  }
  return sections.join("\n\n");
}

export async function buildReviewPrompts(
  files: ChangedFile[],
  diffs: Map<string, string>,
  lens: ReviewLens,
): Promise<ReviewPrompt[]> {
  const context = buildFileContext(files, diffs);

  if (lens !== "all") {
    return [{
      lens,
      systemPrompt: LENS_SYSTEM_PROMPTS[lens],
      userPrompt: `Review the following code changes for ${lens} issues. Output findings as JSON only.\n\n${context}`,
    }];
  }

  const lenses: ReviewLens[] = ["simplicity", "deduplication", "clarity"];
  return lenses.map((l) => ({
    lens: l,
    systemPrompt: LENS_SYSTEM_PROMPTS[l],
    userPrompt: `Review the following code changes. Output findings as JSON only.\n\n${context}`,
  }));
}

export function buildSynthesisPrompt(
  lensReviews: Array<{ lens: ReviewLens; rawOutput: string }>,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are a Senior Engineer Synthesizer. Your job is to review the findings from three independent code reviewers and produce a single, ranked, actionable report.

## Rules
1. Do your own analysis. Rule out false positives. If two reviewers flagged the same issue, note it once with higher confidence.
2. Rank every finding by severity: critical > high > medium > low > nit.
3. A "critical" finding affects correctness, security, or data integrity.
4. A "high" finding significantly impacts maintainability or performance.
5. A "medium" finding is a clear improvement worth making.
6. A "low" finding is a nice-to-have or stylistic preference.
7. A "nit" is very minor — author may ignore.
8. Collapse duplicates across reviewers.
9. Present findings grouped by severity, then by file.
10. Include a brief summary at the top: total counts and top concern.
11. Apply the approval standard: approve a change when it definitely improves overall code health, even if it isn't perfect. Don't block on personal preference.
12. Be honest. Don't rubber-stamp. Quantify problems when possible.

## Output Format
Output the final report as a single JSON object:

{
  "summary": "One sentence describing the top concern",
  "verdict": "Approve|Request changes|Needs security review",
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical|high|medium|low|nit",
      "category": "SQL Injection Risk",
      "summary": "One-line description",
      "detail": "Detailed explanation with impact",
      "suggestion": "Specific fix",
      "confidence": "confirmed|likely|suspect"
    }
  ]
}

Rules:
- Output ONLY the JSON object. No markdown code fences, no extra commentary.
- Findings must be sorted by severity (critical first, then high, medium, low, nit)
- confidence must be one of: confirmed, likely, suspect
- verdict must be one of: Approve, Request changes, Needs security review`;

  let userPrompt = "# Independent Reviewer Findings\n\n";
  for (const review of lensReviews) {
    userPrompt += `## ${review.lens.toUpperCase()} REVIEWER\n\n${review.rawOutput}\n\n---\n\n`;
  }
  userPrompt += "\nSynthesize these findings into the final JSON report.";

  return { systemPrompt, userPrompt };
}

export function buildAutoInjectBlock(edits: { files: ReadonlyArray<{ path: string; language: string | null }> }): string {
  const fileList = edits.files.map((f) => f.path).join(", ");
  return `\n\n## KISS/DRY Quick Check

You edited: ${fileList}. Before proceeding, briefly verify:

- [ ] **KISS**: Is the new code as simple as the problem allows? No unnecessary layers or clever one-liners?
- [ ] **DRY**: Is knowledge represented once? No copy-pasted logic or scattered conditionals?
- [ ] **Names**: Do variables/functions reveal intent, not mechanism? (No 'temp', 'data', 'result' without context)
- [ ] **Size**: Are functions focused on one thing? Any function worth splitting?
- [ ] **Comments**: Do they explain WHY, not WHAT?
- [ ] **Edge cases**: Are null, empty, and boundary values handled?
- [ ] **Security**: Is user input validated at boundaries? No raw SQL concatenation?

Fix any quick wins, then continue.`;
}
