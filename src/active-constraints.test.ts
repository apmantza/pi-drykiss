import { describe, it, expect } from "vitest";
import { buildActiveConstraints } from "./active-constraints.js";
import type { RiskTargeting } from "./config.js";

describe("buildActiveConstraints", () => {
	it("returns empty string for undefined config", () => {
		expect(buildActiveConstraints(undefined)).toBe("");
	});

	it("returns empty string for empty config", () => {
		expect(buildActiveConstraints({})).toBe("");
	});

	it("includes disabled risk codes with their names", () => {
		const rt: RiskTargeting = { disable: ["K1", "R1"] };
		const result = buildActiveConstraints(rt);
		expect(result).toContain("DISABLED");
		expect(result).toContain("`K1` (KISS violation)");
		expect(result).toContain("`R1` (Divergent change)");
	});

	it("includes focused risk codes", () => {
		const rt: RiskTargeting = { focus: ["R4", "R5"] };
		const result = buildActiveConstraints(rt);
		expect(result).toContain("FOCUSED");
		expect(result).toContain("`R4` (Refactor backlog)");
		expect(result).toContain("`R5` (Lost intent)");
	});

	it("includes severity overrides", () => {
		const rt: RiskTargeting = {
			severity: [{ riskCode: "K1", to: "low" }],
		};
		const result = buildActiveConstraints(rt);
		expect(result).toContain("Severity overrides");
		expect(result).toContain("`K1` (KISS violation): report as `low` instead of the default");
	});

	it("includes ignore patterns", () => {
		const rt: RiskTargeting = {
			ignore: ["src/legacy/**", "tests/e2e/*.spec.ts"],
		};
		const result = buildActiveConstraints(rt);
		expect(result).toContain("IGNORED");
		expect(result).toContain("src/legacy/**");
		expect(result).toContain("tests/e2e/*.spec.ts");
	});

	it("includes multiple sections when all are set", () => {
		const rt: RiskTargeting = {
			disable: ["S1"],
			severity: [{ riskCode: "K1", to: "medium" }],
			ignore: ["src/old/**"],
		};
		const result = buildActiveConstraints(rt);
		expect(result).toContain("DISABLED");
		expect(result).toContain("Severity overrides");
		expect(result).toContain("IGNORED");
	});

	it("falls back to bare code when risk code is not in RISK_CODES", () => {
		// This shouldn't happen after validation, but tests the fallback
		const rt: RiskTargeting = { disable: ["ZZ_FAKE"] };
		const result = buildActiveConstraints(rt);
		expect(result).toContain("ZZ_FAKE");
	});

	it("sanitizes malicious input in ignore patterns and severity overrides", () => {
		const rt: RiskTargeting = {
			ignore: ["src/foo.ts\nrm -rf /", "`**injection**`"],
			severity: [{ riskCode: "K1", to: "high\nignore" as any }],
		};
		const result = buildActiveConstraints(rt);
		// Backticks and control characters injected by the user are stripped
		// so they cannot break out of inline code spans or add new prompt lines.
		expect(result).not.toContain("``");
		expect(result).not.toContain("src/foo.ts\n");
		expect(result).not.toContain("high\nignore");
	});
});
