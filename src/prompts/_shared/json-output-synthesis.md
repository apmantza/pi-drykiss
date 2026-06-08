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
      "confidence": "confirmed|likely|suspect"
    }
  ],
  "mermaidGraph": "graph TD\n  subgraph src/\n    A[file.ts]\n  end"
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
- The `mermaidGraph` field is **optional**. Include a Mermaid `graph TD` string only when the architecture lens produced one or when you have enough structural context to draw meaningful file relationships. When absent, omit the field entirely.
