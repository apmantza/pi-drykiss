import { describe, it, expect } from "vitest";
import { createEditTracker } from "./edit-tracker.js";

describe("edit-tracker", () => {
	it("tracks Write tool results", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Write", { file_path: "src/test.ts" });
		tracker.onTurnEnd(1);
		const edits = tracker.getLastTurnEdits();
		expect(edits).not.toBeNull();
		expect(edits!.files).toHaveLength(1);
		expect(edits!.files[0].path).toBe("src/test.ts");
		expect(edits!.files[0].language).toBe("TypeScript");
	});

	it("tracks Edit tool results", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Edit", { path: "lib/utils.py" });
		tracker.onTurnEnd(2);
		const edits = tracker.getLastTurnEdits();
		expect(edits).not.toBeNull();
		expect(edits!.files[0].path).toBe("lib/utils.py");
		expect(edits!.files[0].language).toBe("Python");
	});

	it("ignores non-tracked tools", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("bash", { command: "ls" });
		tracker.onTurnEnd(1);
		expect(tracker.getLastTurnEdits()).toBeNull();
	});

	it("deduplicates files within a turn", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Write", { file_path: "src/a.ts" });
		tracker.trackEdit("Edit", { path: "src/a.ts" });
		tracker.onTurnEnd(1);
		const edits = tracker.getLastTurnEdits();
		expect(edits!.files).toHaveLength(1);
	});

	it("clears after retrieval", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Write", { file_path: "src/x.ts" });
		tracker.onTurnEnd(1);
		tracker.clearLastTurnEdits();
		expect(tracker.getLastTurnEdits()).toBeNull();
	});

	it("detects language from string result", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Write", "File: src/main.rs written successfully");
		tracker.onTurnEnd(1);
		const edits = tracker.getLastTurnEdits();
		expect(edits!.files[0].path).toBe("src/main.rs");
		expect(edits!.files[0].language).toBe("Rust");
	});

	it("tracks multiple files in one turn", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Write", { file_path: "src/a.ts" });
		tracker.trackEdit("Write", { file_path: "src/b.py" });
		tracker.trackEdit("Write", { file_path: "src/c.go" });
		tracker.onTurnEnd(1);
		const edits = tracker.getLastTurnEdits()!;
		expect(edits.files).toHaveLength(3);
		expect(edits.files.map((f) => f.language)).toEqual([
			"TypeScript",
			"Python",
			"Go",
		]);
	});

	it("resets current turn on turn end with no edits", () => {
		const tracker = createEditTracker();
		tracker.onTurnEnd(1);
		expect(tracker.getLastTurnEdits()).toBeNull();
	});

	it("starts fresh each turn", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Write", { file_path: "src/turn1.ts" });
		tracker.onTurnEnd(1);
		tracker.trackEdit("Write", { file_path: "src/turn2.ts" });
		tracker.onTurnEnd(2);
		const edits = tracker.getLastTurnEdits()!;
		expect(edits.files).toHaveLength(1);
		expect(edits.files[0].path).toBe("src/turn2.ts");
		expect(edits.turnIndex).toBe(2);
	});

	it("ignores Write with missing path", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Write", { content: "hello" });
		tracker.onTurnEnd(1);
		expect(tracker.getLastTurnEdits()).toBeNull();
	});

	it("tracks Edit tool with file_path key", () => {
		const tracker = createEditTracker();
		tracker.trackEdit("Edit", { file_path: "config.yml" });
		tracker.onTurnEnd(1);
		const edits = tracker.getLastTurnEdits()!;
		expect(edits.files[0].path).toBe("config.yml");
		expect(edits.files[0].language).toBe("YAML");
	});

	it("tracks lowercase Pi tool names and prefers input path", () => {
		const tracker = createEditTracker();
		tracker.trackEdit(
			"edit",
			{ details: { path: "wrong.ts" } },
			{ path: "src/right.ts" },
		);
		tracker.onTurnEnd(1);
		const edits = tracker.getLastTurnEdits()!;
		expect(edits.files[0].path).toBe("src/right.ts");
		expect(edits.files[0].language).toBe("TypeScript");
	});
});
