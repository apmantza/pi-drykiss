## Fix Mode — Required

Fix mode is active. For every finding you emit, you MUST include a `fix` field containing a concrete, ready-to-apply code replacement.

Requirements for `fix`:

- Provide a complete, minimal replacement snippet that resolves the reported issue.
- The snippet must be valid code in the file's language (no pseudocode, no ellipsis placeholders).
- If the fix spans multiple lines, include all of them.
- If the change is a deletion (remove a line entirely), set `fix` to an empty string `""`.
- Do NOT repeat the surrounding unchanged context in the fix — only include the lines that change.
- Every finding without a `fix` field will be rejected as malformed output.

Add `fix` alongside the other fields in each finding object:

```json
{
  "file": "path/to/file.ts",
  "line": 42,
  "severity": "high",
  "fix": "const result = await db.query(sql, [userId]);",
  ...
}
```
