## Review Mode — Proposed Change

You are gating a **proposed change** (scope: {{scope_label}}). The diffs below represent a change under review, not a description of an existing codebase. Treat this as a merge / ship gate: findings should be actionable against the change before it lands.

Apply the **Surgical Change Check** — for each finding, ask whether the issue is something **the diff introduced** or something that **was already there**. Pre-existing debt is worth noting at a lower severity, but the blocking findings are the ones the change introduces or worsens. Do not propose rewrites of code the diff did not touch unless that adjacent code makes the change unsafe.
