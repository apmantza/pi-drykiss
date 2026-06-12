import { describe, it, expect } from "vitest";
import { createEditTracker } from "./edit-tracker.js";

const WRITE_TOOL = "write";
const EDIT_TOOL = "edit";

describe("createEditTracker", () => {
	it("tracks edits from the 'write' tool", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, {
			path: "src/foo.ts",
		});
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/foo.ts");
	});

	it("tracks edits from the 'edit' tool", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(EDIT_TOOL, {
			path: "src/bar.ts",
		});
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/bar.ts");
	});

	it("ignores untracked tools", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit("read", {
			path: "src/foo.ts",
		});
		expect(result).toBeNull();
	});

	it("ignores case in tool name", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit("WRITE", {
			path: "src/foo.ts",
		});
		expect(result).not.toBeNull();
	});

	it("extracts path from 'file_path' key", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, {
			file_path: "src/deep.ts",
		});
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/deep.ts");
	});

	it("extracts path from 'filePath' key", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, {
			filePath: "src/camel.ts",
		});
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/camel.ts");
	});

	it("extracts path from string result with 'file:' prefix", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, {
			details: "File: src/detail.ts",
		});
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/detail.ts");
	});

	it("extracts path from string result with 'File:' prefix", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(EDIT_TOOL, "File: src/capital.ts");
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/capital.ts");
	});

	it("extracts path from nested details object", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, {
			details: { path: "src/nested.ts" },
		});
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/nested.ts");
	});

	it("detects language from file extension", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, {
			path: "src/app.tsx",
		});
		expect(result).not.toBeNull();
		expect(result!.language).toBe("TypeScript/React");
	});

	it("returns null when path cannot be extracted", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, {
			noise: "no path here",
		});
		expect(result).toBeNull();
	});

	it("rejects absolute paths", () => {
		const tracker = createEditTracker();
		expect(tracker.trackEdit(WRITE_TOOL, { path: "/etc/passwd" })).toBeNull();
		expect(tracker.trackEdit(WRITE_TOOL, { path: "C:\\windows\\system.ini" })).toBeNull();
	});

	it("rejects paths with parent directory traversal", () => {
		const tracker = createEditTracker();
		expect(
			tracker.trackEdit(WRITE_TOOL, { path: "src/../../etc/passwd" }),
		).toBeNull();
	});

	it("rejects paths with injected newlines or control characters", () => {
		const tracker = createEditTracker();
		expect(
			tracker.trackEdit(WRITE_TOOL, { path: "src/foo.ts\nrm -rf /" }),
		).toBeNull();
	});

	it("deduplicates repeated edits to same file", () => {
		const tracker = createEditTracker();
		tracker.trackEdit(WRITE_TOOL, { path: "src/foo.ts" });
		tracker.trackEdit(EDIT_TOOL, { path: "src/foo.ts" });
		tracker.trackEdit(WRITE_TOOL, { path: "src/foo.ts" });
		const result = tracker.getLastTurnEdits();
		expect(result).toBeNull(); // nothing ended yet
	});

	it("onTurnEnd captures edits and clears current state", () => {
		const tracker = createEditTracker();
		tracker.trackEdit(WRITE_TOOL, { path: "src/foo.ts" });
		tracker.trackEdit(EDIT_TOOL, { path: "src/bar.ts" });
		tracker.onTurnEnd(0);
		const turn = tracker.getLastTurnEdits();
		expect(turn).not.toBeNull();
		expect(turn!.turnIndex).toBe(0);
		expect(turn!.files).toHaveLength(2);
		expect(turn!.files[0].path).toBe("src/foo.ts");
		expect(turn!.files[1].path).toBe("src/bar.ts");
	});

	it("onTurnEnd sets null when no edits happened", () => {
		const tracker = createEditTracker();
		tracker.onTurnEnd(1);
		expect(tracker.getLastTurnEdits()).toBeNull();
	});

	it("onTurnEnd clears state so subsequent calls see no duplicate files", () => {
		const tracker = createEditTracker();
		tracker.trackEdit(WRITE_TOOL, { path: "src/only.ts" });
		tracker.onTurnEnd(0);
		const turn = tracker.getLastTurnEdits();
		expect(turn!.files).toHaveLength(1);

		// Second turn, no edits
		tracker.onTurnEnd(1);
		expect(tracker.getLastTurnEdits()).toBeNull();
	});

	it("clearLastTurnEdits resets last turn", () => {
		const tracker = createEditTracker();
		tracker.trackEdit(WRITE_TOOL, { path: "src/foo.ts" });
		tracker.onTurnEnd(0);
		expect(tracker.getLastTurnEdits()).not.toBeNull();
		tracker.clearLastTurnEdits();
		expect(tracker.getLastTurnEdits()).toBeNull();
	});

	it("rejects paths containing control characters", () => {
		const tracker = createEditTracker();
		// Embed a newline to simulate injection attempt
		const result = tracker.trackEdit(WRITE_TOOL, {
			path: "src/foo.ts\nrm -rf /",
		});
		expect(result).toBeNull();
	});

	it("returns null for null result", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, null);
		expect(result).toBeNull();
	});

	it("returns null for undefined result", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(WRITE_TOOL, undefined);
		expect(result).toBeNull();
	});

	it("handles string input for file path extraction", () => {
		const tracker = createEditTracker();
		const result = tracker.trackEdit(
			"write",
			{ status: "ok" },
			"path: src/from-input.ts",
		);
		expect(result).not.toBeNull();
		expect(result!.path).toBe("src/from-input.ts");
	});
});
