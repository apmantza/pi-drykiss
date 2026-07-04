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
    "consequence": "What goes wrong if this is left unfixed (impact, blast radius)",
    "source": "Why you flagged it: principle name, rule, or pattern name (e.g. 'KISS: thin wrapper')",
    "fixability": "quick-fix|guided|manual",
    "suggestion": "Specific fix or alternative approach",
    "action": "fix|discuss|ignore",
    "riskLevel": "low|medium|high",
    "priority": "P0|P1|P2|P3"
  }
]

Rules:

- Output ONLY the JSON array. No markdown code fences, no extra commentary.
- If no issues found, output: []
- Use actual file paths from the supplied review context.
- Line numbers are optional but strongly preferred when known.
- severity must be one of: critical, high, medium, low, nit.
- Every finding must have a non-empty category, summary, detail, consequence, source, fixability, and suggestion.
- Every finding must name the concrete code evidence in detail: what is present, why it matters, and the smallest practical fix.
- When useful, include the evidence type in `source`: `project-standard`, `intent/spec`, or `quality-smell`. Example: `quality-smell: duplicated knowledge`.
- Do not report vague findings like "needs more tests", "god module", "consider refactoring", or "could be cleaner" unless you identify a specific behavior, boundary, duplicated rule, or code path and a minimal fix.
- `fixability` describes the *size* of the fix: `quick-fix` (one-line, mechanical), `guided` (touches a few lines, requires the author to follow the suggestion), `manual` (requires design judgment, may not be appropriate to apply directly).
- `action` describes the *recommended response*: `fix` (apply the suggestion), `discuss` (challenges intent or needs human judgment), `ignore` (informational / nit).
- `riskLevel` describes the *blast radius* independent of severity: `low` (localized), `medium` (correctness/maintainability), `high` (security, reliability, architecture).
- `priority` is an optional Codex-style tag: `P0` (drop everything), `P1` (urgent), `P2` (normal), `P3` (nice to have). If omitted, synthesis will infer it from severity.
- Default `action` to `fix` when the finding is concrete and high-confidence; use `discuss` for intent-challenging issues; use `ignore` only for informational nits.
- Default `riskLevel` from the lens domain: security/architecture/resilience findings trend `high`; clarity/simplicity trends `low` to `medium`; tests trend `medium`.
