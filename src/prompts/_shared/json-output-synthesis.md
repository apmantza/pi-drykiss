## 🔴 CRITICAL: Output Format — Must output valid JSON

Output the final report as a single JSON object. Failure to output valid JSON will cause the review to be rejected.

Example (do NOT include any surrounding text or fences):

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
      "consequence": "What goes wrong if this is left unfixed",
      "source": "Which lens(es) flagged this: 'simplicity+clarity' or 'security'",
      "fixability": "quick-fix|guided|manual",
      "suggestion": "Specific fix",
      "confidence": "confirmed|likely|suspect",
      "action": "fix|discuss|ignore",
      "riskLevel": "low|medium|high",
      "priority": "P0|P1|P2|P3"
    }
  ],
  "mermaidGraph": "graph TD\n  subgraph src/\n    A[file.ts]\n  end",
  "files": [
    { "path": "path/to/file.ts", "role": "read", "description": "why it matters" }
  ],
  "nextSteps": ["recommended follow-up action"],
  "notDone": [
    { "item": "unfinished work", "reason": "why it was not completed", "blocker": "blocking issue", "nextStep": "specific follow-up" }
  ],
  "extensions": { "mermaidGraph": "..." }
}

Rules:

- Output ONLY the JSON object. No markdown code fences, no extra commentary.
- Findings must be sorted by severity (critical first, then high, medium, low, nit)
- confidence must be one of: confirmed, likely, suspect
- verdict must be one of: Approve, Request changes, Needs security review
- Deduplicate overlapping findings from multiple lenses into one finding with the most accurate severity. When merging, set `source` to a `+`-joined list of the contributing lenses (e.g. `simplicity+clarity`).
- Down-rank broad maintainability, test coverage, and file-size concerns unless they identify a concrete broken behavior, security risk, or high-probability maintenance failure.
- Never synthesize a critical finding from maintainability concerns alone. Critical requires exploitable security risk, data loss, or currently broken core functionality.
- Preserve the per-lens `consequence` and `fixability` fields from the original findings when merging; only edit if a downstream lens added evidence.
- Preserve or set `action` and `riskLevel` on each synthesized finding. Use `action: fix` for concrete high-confidence suggestions, `discuss` for intent-challenging issues, and `ignore` for informational nits.
- Use `riskLevel` to signal blast radius: `high` for security/reliability/architecture, `medium` for correctness/maintainability, `low` for localized style/nit issues.
- Optionally set `priority` (P0–P3) on synthesized findings. If individual lens findings include priority tags, propagate the highest priority. If omitted, the UI will infer it from severity.
- The `mermaidGraph` field is **optional**. Include a Mermaid `graph TD` string only when the architecture lens produced one or when you have enough structural context to draw meaningful file relationships. When absent, omit the field entirely.
- The `files`, `nextSteps`, `notDone`, and `extensions` fields are **optional**. Include them only when they add value. `files` should list files actually inspected; `nextSteps` should list concrete follow-ups; `notDone` should surface incomplete lens work; `extensions` is for lens-specific structured data such as an architecture dependency graph.
- **CRITICAL: the verdict must be consistent with the findings list.** If `findings` is empty, the verdict MUST be `Approve`. Do not emit `Request changes` or `Needs security review` when no findings are present. A non-approving verdict requires at least one actionable finding.
- When the architecture lens supplies a dependency graph, prefer placing it in `extensions.mermaidGraph` and only duplicate it at the top-level `mermaidGraph` if it is the most useful visualization for the report.
