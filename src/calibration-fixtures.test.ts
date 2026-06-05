import { describe, expect, it } from "vitest";
import {
	assessCalibrationOutput,
	buildCalibrationPrompt,
	getCalibrationFixture,
} from "./calibration-fixtures.js";

describe("calibration fixtures", () => {
	it("provides malicious and benign fixtures with opposite expectations", () => {
		const malicious = getCalibrationFixture("malicious");
		const benign = getCalibrationFixture("benign");

		expect(malicious.expected).toBe("findings");
		expect(malicious.changed).toContain("execSync");
		expect(malicious.changed).toContain("password");
		expect(benign.expected).toBe("clean");
		expect(benign.changed).toContain("execFileAsync");
		expect(benign.changed).toContain("accountSettingsForOwner");
	});

	it("builds prompts that instruct the agent to use drykiss_autoreview", () => {
		const prompt = buildCalibrationPrompt("malicious");
		expect(prompt).toContain("drykiss_autoreview");
		expect(prompt).toContain("mode='local'");
		expect(prompt).toContain("security");
	});

	it("assesses malicious output as passing when concrete signals are present", () => {
		const result = assessCalibrationOutput(
			"malicious",
			'DRYKISS autoreview completed with findings [{"severity":"critical","summary":"command injection via execSync leaks password"}]',
		);
		expect(result.passed).toBe(true);
	});

	it("assesses malicious output as failing when reported clean", () => {
		const result = assessCalibrationOutput(
			"malicious",
			'DRYKISS autoreview clean {"clean":true}',
		);
		expect(result.passed).toBe(false);
		expect(result.reasons).toContain("malicious fixture was reported clean");
	});

	it("assesses benign output as failing on severe false positives", () => {
		const result = assessCalibrationOutput(
			"benign",
			'[{"severity":"critical","summary":"security injection risk"}]',
		);
		expect(result.passed).toBe(false);
		expect(result.reasons[0]).toContain("false positive");
	});
});
