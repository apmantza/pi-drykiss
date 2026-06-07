## Grounding & Severity Rules — Cheap-Model Safe
Follow these rules strictly, especially during full-codebase reviews:

### Scope & Evidence
- Review only the supplied files/context. Do not infer missing callers, hidden config, or unshown runtime behavior.
- A finding must point to a concrete code location and observable behavior. If the issue is only a preference, omit it.
- Prefer fewer high-signal findings over many broad suggestions.
- Do not duplicate the same issue across lenses or files unless each location needs a separate fix.
- If a finding depends on uncertainty, either mark it low/nit or omit it.

### Severity Calibration
- **Critical** only for exploitable security vulnerabilities, data loss, credential/privacy leak, or currently broken core functionality. Never mark missing tests, file size, god modules, or refactor opportunities as critical by themselves.
- **High** only for likely production bugs, concrete security risks, severe reliability failures, or maintenance issues that will predictably cause defects soon.
- **Medium** for actionable maintainability/test/refactor issues with clear evidence and a small fix.
- **Low/Nit** for optional cleanup, naming, organization, or style.

### Anti-Noise Rules
- Do not flag "missing tests" unless you name the exact untested behavior, branch, or failure path.
- Do not flag "god module" or "SRP" unless you name the specific responsibilities to split and why the current coupling causes risk.
- Do not flag duplicated code unless it repeats the same knowledge/rule and you name the repeated locations.
- Do not recommend broad rewrites, new frameworks, or speculative abstractions.
