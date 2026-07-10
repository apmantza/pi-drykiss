# Review benchmark fixtures

Each child directory is a versioned, PR-style fixture:

- `manifest.json` declares reviewed paths, seeded findings, allowed
  non-findings, false-positive traps, and materiality expectation.
- `diff.patch` is the patch presented to a diff review.
- `app.js` is optional full-file context.

The deterministic scorer deliberately does not call a model. Record model
output as a JSON artifact, then score it:

```bash
npm run review:bench -- --results path/to/runs.json
```

`runs.json` must use schema version 1:

```json
{
  "schemaVersion": 1,
  "runs": [
    {
      "fixtureId": "command-injection",
      "findings": [
        {
          "file": "app.js",
          "line": 9,
          "severity": "high",
          "riskCode": "S1",
          "summary": "Command injection through the shell command"
        }
      ],
      "calls": 9,
      "estimatedTokens": 12000,
      "elapsedMs": 42000
    }
  ]
}
```

Live-model runs are intentionally external and opt-in. Generate the recorded
artifact with an explicitly chosen model/configuration, retain it under a
versioned results directory outside CI, and pass it to this scorer. CI tests
fixture parsing and deterministic scoring only.
