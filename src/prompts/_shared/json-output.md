## Output Format — REQUIRED

Output findings as a single JSON array. No markdown fences, no extra commentary. If no issues, output `[]`.

```json
[
  {
    "file": "path/to/file.ts",
    "line": 42,
    "severity": "critical|high|medium|low|nit",
    "category": "SQL Injection Risk",
    "summary": "One-line description",
    "detail": "Specific evidence. Quote the code and explain why it matters in this context.",
    "consequence": "Impact if left unfixed (blast radius)",
    "source": "Principle/rule or evidence type: project-standard | intent/spec | quality-smell",
    "fixability": "quick-fix|guided|manual",
    "suggestion": "Specific fix or alternative",
    "action": "fix|discuss|ignore",
    "riskLevel": "low|medium|high",
    "priority": "P0|P1|P2|P3"
  }
]
```

Rules:

- Output ONLY the JSON array.
- Every finding must have a non-empty `category`, `summary`, `detail`, `consequence`, `source`, `fixability`, and `suggestion`.
- `severity` must be one of the listed values; `critical` only for exploitable security, data loss, or broken core functionality.
- Be specific: quote code, name files/lines, and explain the concrete harm. No vague claims like "needs more tests" or "consider refactoring".
- `fixability` = size of fix; `action` = recommended response; `riskLevel` = blast radius; `priority` = optional urgency.
- Inside string values (e.g. `detail`, `suggestion`), escape double quotes as `\"`, or use single quotes for inline code references: `loadPromptBody('iron-law', 'shared')`. Unescaped double quotes inside a string break JSON parsing and cause the review to be dropped.
