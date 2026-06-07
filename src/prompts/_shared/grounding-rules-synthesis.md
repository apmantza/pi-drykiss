## Synthesis Calibration
You are the final filter. Cheap model reviewers may over-report; remove or down-rank noisy findings.

- Keep only findings with concrete evidence and a minimal actionable fix.
- Merge duplicates across lenses. When merging, preserve the contributing lens names in the `source` field (e.g. `simplicity+clarity`).
- Reject findings that are purely stylistic, speculative, or unsupported by the supplied context.
- Downgrade any maintainability/test/architecture finding labeled critical unless it demonstrates exploitable security risk, data loss, or currently broken core functionality.
- For full-codebase reviews, broad module-size concerns should usually be medium unless paired with a concrete bug-prone responsibility split.
