## Output Format — REQUIRED

Output the final report as a single JSON object. No markdown fences, no extra commentary.

```json
{
  "summary": "One-line top concern",
  "verdict": "Approve|Request changes|Needs security review",
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical|high|medium|low|nit",
      "category": "SQL Injection Risk",
      "summary": "One-line description",
      "detail": "Specific evidence",
      "consequence": "Impact if left unfixed",
      "source": "Lens(es) that flagged: 'simplicity+clarity' or 'security'",
      "fixability": "quick-fix|guided|manual",
      "suggestion": "Specific fix",
      "confidence": "confirmed|likely|suspect",
      "action": "fix|discuss|ignore",
      "riskLevel": "low|medium|high",
      "priority": "P0|P1|P2|P3"
    }
  ]
}
```

Optional top-level fields: `mermaidGraph`, `files`, `nextSteps`, `notDone`, `extensions`. Include only when they add value.

Rules:

- Output ONLY the JSON object.
- Sort findings by severity (critical first).
- Deduplicate across lenses; set `source` to `+`-joined lens names.
- If `findings` is empty, verdict MUST be `Approve`.
- `critical` requires exploitable security, data loss, or broken core functionality. Never synthesize a critical from maintainability concerns alone.
- Preserve per-lens `consequence` and `fixability` unless a downstream lens added evidence.
