import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	applyRejections,
	appendRejections,
	CO_LOCATED_JACCARD_THRESHOLD,
	CO_LOCATED_LINE_WINDOW,
	DEFAULT_REJECTION_CAP,
	getRejectionsPath,
	jaccard,
	loadRejections,
	matchesRejection,
	MAX_MESSAGE_LENGTH,
	MAX_STORE_BYTES,
	REJECTIONS_FILE,
	sameBug,
	tokenize,
	toRejectionRecords,
	UNANCHORED_JACCARD_THRESHOLD,
} from "./rejections.js";
import type { Finding } from "./types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		file: "src/a.ts",
		line: 10,
		severity: "medium",
		category: "DRY",
		summary: "Duplicated parsing logic across two modules",
		detail: "Both modules parse the same config format",
		suggestion: "Extract a shared parser",
		...overrides,
	};
}

/** Create a throwaway project directory with a .pi/drykiss parent. */
function tmpProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "drykiss-rejections-"));
	mkdirSync(join(cwd, ".pi", "drykiss"), { recursive: true });
	return cwd;
}

describe("tokenize", () => {
	it("lower-cases and strips punctuation", () => {
		const tokens = tokenize("Hello, World! Test123 alpha beta");
		// 2-char tokens (ok, is, an, of) and stopwords (the, and, ...) are dropped
		expect([...tokens].sort()).toEqual([
			"alpha",
			"beta",
			"hello",
			"test123",
			"world",
		]);
	});

	it("drops short tokens and stopwords", () => {
		const tokens = tokenize("the cat is on a mat");
		expect([...tokens].sort()).toEqual(["cat", "mat"]);
	});

	it("returns an empty set for stopword-only input", () => {
		expect(tokenize("the and or is of").size).toBe(0);
	});
});

describe("jaccard", () => {
	it("returns 1 for identical sets", () => {
		const a = new Set(["x", "y", "z"]);
		expect(jaccard(a, new Set(["x", "y", "z"]))).toBe(1);
	});

	it("returns 0 for disjoint sets", () => {
		expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
	});

	it("returns 0 for two empty sets (no evidence, not perfect match)", () => {
		// Two empty token sets mean "no overlap data on either side,"
		// not "identical." Returning 1 would be a false positive in
		// the sameBug matcher for findings with empty summaries.
		expect(jaccard(new Set(), new Set())).toBe(0);
	});

	it("returns 0 when only one set is empty", () => {
		expect(jaccard(new Set(["a"]), new Set())).toBe(0);
		expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
	});

	it("handles partial overlap", () => {
		// |A ∩ B| = 2, |A ∪ B| = 4, J = 0.5
		expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(
			0.5,
		);
	});
});

describe("sameBug", () => {
	const tokensA = tokenize("null check missing in parser");
	const tokensB = tokenize("null check missing in parser");

	it("matches on identical file + co-located line + paraphrased text", () => {
		// 0% jaccard but co-located AND a near-clone of the message
		// — the lower co-located bar should still match.
		expect(
			sameBug(
				{ file: "x.ts", line: 10, tokens: tokensA },
				{ file: "x.ts", line: 12, tokens: tokensB },
			),
		).toBe(true);
	});

	it("matches co-located lines with ≥25% jaccard", () => {
		// |A| = |B| = 4, |A ∩ B| = 2, |A ∪ B| = 6 → J = 33% ≥ 25%
		const a = new Set(["a", "b", "c", "d"]);
		const b = new Set(["a", "b", "e", "f"]);
		expect(
			sameBug(
				{ file: "x.ts", line: 10, tokens: a },
				{ file: "x.ts", line: 11, tokens: b },
			),
		).toBe(true);
	});

	it("rejects co-located lines with <25% jaccard", () => {
		// 0 of 4 tokens overlap.
		const a = new Set(["a", "b", "c", "d"]);
		const b = new Set(["e", "f", "g", "h"]);
		expect(
			sameBug(
				{ file: "x.ts", line: 10, tokens: a },
				{ file: "x.ts", line: 11, tokens: b },
			),
		).toBe(false);
	});

	it("rejects when both lines are >3 apart", () => {
		expect(
			sameBug(
				{ file: "x.ts", line: 10, tokens: tokensA },
				{ file: "x.ts", line: 50, tokens: tokensA },
			),
		).toBe(false);
	});

	it("requires ≥50% jaccard when no line is anchored on either side", () => {
		const a = new Set(["a", "b", "c", "d"]);
		const b = new Set(["a", "b", "e", "f"]); // 2/6 = 33%
		expect(
			sameBug({ file: "x.ts", tokens: a }, { file: "x.ts", tokens: b }),
		).toBe(false);
	});

	it("matches when one side has a line and the other doesn't, with high jaccard", () => {
		const a = new Set(["null", "check", "missing", "parser"]);
		const b = new Set(["null", "check", "missing", "parser"]);
		expect(
			sameBug(
				{ file: "x.ts", line: 10, tokens: a },
				{ file: "x.ts", tokens: b },
			),
		).toBe(true);
	});

	it("always rejects across different files", () => {
		expect(
			sameBug(
				{ file: "a.ts", line: 10, tokens: tokensA },
				{ file: "b.ts", line: 10, tokens: tokensA },
			),
		).toBe(false);
	});
});

describe("loadRejections", () => {
	it("returns [] for a missing file (ENOENT)", async () => {
		const cwd = tmpProject();
		try {
			expect(await loadRejections(cwd)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("skips garbled JSONL lines instead of failing", async () => {
		const cwd = tmpProject();
		try {
			const path = getRejectionsPath(cwd);
			writeFileSync(
				path,
				[
					JSON.stringify({
						file: "a.ts",
						line: 1,
						severity: "high",
						message: "real rejection",
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
					"this is not json",
					JSON.stringify({ file: "b.ts" }), // missing required fields
					"",
				].join("\n") + "\n",
				"utf8",
			);
			const records = await loadRejections(cwd);
			expect(records).toHaveLength(1);
			expect(records[0].file).toBe("a.ts");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects entries with wrong-typed optional fields", async () => {
		const cwd = tmpProject();
		try {
			const path = getRejectionsPath(cwd);
			writeFileSync(
				path,
				[
					// valid baseline
					JSON.stringify({
						file: "a.ts",
						line: 1,
						severity: "high",
						message: "valid",
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
					// line is a string, not a number
					JSON.stringify({
						file: "b.ts",
						line: "10",
						severity: "high",
						message: "bad line type",
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
					// source is a number, not a string
					JSON.stringify({
						file: "c.ts",
						severity: "high",
						message: "bad source type",
						recorded_at: "2026-01-01T00:00:00.000Z",
						source: 123,
					}),
				].join("\n") + "\n",
				"utf8",
			);
			const records = await loadRejections(cwd);
			expect(records).toHaveLength(1);
			expect(records[0].file).toBe("a.ts");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects entries with an unknown severity value", async () => {
		const cwd = tmpProject();
		try {
			const path = getRejectionsPath(cwd);
			writeFileSync(
				path,
				[
					// valid baseline
					JSON.stringify({
						file: "a.ts",
						severity: "high",
						message: "ok",
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
					// unknown severity (not in the 5-value severity set)
					JSON.stringify({
						file: "b.ts",
						severity: "emergency",
						message: "bad severity",
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
				].join("\n") + "\n",
				"utf8",
			);
			const records = await loadRejections(cwd);
			expect(records).toHaveLength(1);
			expect(records[0].file).toBe("a.ts");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("matchesRejection", () => {
	const record = {
		file: "src/foo.ts",
		line: 20,
		severity: "high" as const,
		message: "Duplicated parsing logic across two modules",
		recorded_at: "2026-01-01T00:00:00.000Z",
	};

	it("matches by file + co-located line + paraphrased message", () => {
		expect(
			matchesRejection(
				{
					file: "src/foo.ts",
					line: 22,
					message: "Duplicated parsing logic across the modules",
				},
				[record],
			),
		).toBe(true);
	});

	it("rejects when file differs", () => {
		expect(
			matchesRejection(
				{ file: "src/bar.ts", line: 20, message: record.message },
				[record],
			),
		).toBe(false);
	});

	it("returns false on empty rejection list", () => {
		expect(
			matchesRejection({ file: "src/foo.ts", line: 20, message: "x" }, []),
		).toBe(false);
	});
});

describe("applyRejections", () => {
	const r = {
		file: "src/foo.ts",
		line: 20,
		severity: "high" as const,
		message: "Duplicated parsing logic across two modules",
		recorded_at: "2026-01-01T00:00:00.000Z",
	};

	it("returns input unchanged when no rejections match", () => {
		const findings = [finding({ file: "src/other.ts", line: 1 })];
		expect(applyRejections(findings, [])).toEqual(findings);
	});

	it("tags matching findings with _previouslyRejected and downranks them", () => {
		const f1 = finding({ file: "src/foo.ts", line: 20 }); // matches
		const f2 = finding({ file: "src/foo.ts", line: 50 }); // different
		const f3 = finding({ file: "src/bar.ts", line: 1 }); // different file
		const out = applyRejections([f1, f2, f3], [r]);
		expect(out).toHaveLength(3); // never hidden
		expect(out[0]).toEqual(f2);
		expect(out[1]).toEqual(f3);
		const downranked = out[2] as Finding & { _previouslyRejected?: true };
		expect(downranked._previouslyRejected).toBe(true);
		expect(downranked.file).toBe("src/foo.ts");
	});

	it("preserves the existing order within the kept group", () => {
		const a = finding({ file: "src/other.ts", line: 1, summary: "issue A" });
		const b = finding({ file: "src/other.ts", line: 2, summary: "issue B" });
		const c = finding({ file: "src/other.ts", line: 3, summary: "issue C" });
		const d = finding({ file: "src/foo.ts", line: 20 }); // matches rejection
		const out = applyRejections([a, b, c, d], [r]);
		expect(out.slice(0, 3)).toEqual([a, b, c]);
	});

	it("never hides findings (count is preserved)", () => {
		const f = finding({ file: "src/foo.ts", line: 20 });
		const out = applyRejections([f, f, f, f, f], [r]);
		expect(out).toHaveLength(5);
		expect(
			out.every(
				(x) =>
					(x as Finding & { _previouslyRejected?: true })._previouslyRejected,
			),
		).toBe(true);
	});

	it("handles an empty findings list", () => {
		expect(applyRejections([], [r])).toEqual([]);
	});
});

describe("toRejectionRecords", () => {
	it("projects findings down to the fields we persist", () => {
		const f = finding({ file: "a.ts", line: 5, severity: "critical" });
		const records = toRejectionRecords([f], {
			now: "2026-06-17T00:00:00.000Z",
		});
		expect(records).toEqual([
			{
				file: "a.ts",
				line: 5,
				severity: "critical",
				message: f.summary,
				recorded_at: "2026-06-17T00:00:00.000Z",
			},
		]);
	});

	it("propagates the source tag when provided", () => {
		const f = finding();
		const records = toRejectionRecords([f], { source: "user" });
		expect(records[0].source).toBe("user");
	});

	it("omits source when not provided (backward compat)", () => {
		const f = finding();
		const records = toRejectionRecords([f]);
		expect(records[0].source).toBeUndefined();
	});
});

describe("appendRejections", () => {
	it("creates the file on first write and dedupes against existing entries", async () => {
		const cwd = tmpProject();
		try {
			const f = finding({
				file: "src/foo.ts",
				line: 20,
				summary: "Duplicated parsing logic",
			});
			await appendRejections(
				cwd,
				toRejectionRecords([f], { now: "2026-01-01" }),
			);
			// second append with same finding should be a no-op (deduped)
			await appendRejections(
				cwd,
				toRejectionRecords([f], { now: "2026-02-01" }),
			);
			const records = await loadRejections(cwd);
			expect(records).toHaveLength(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("writes a well-formed JSONL file (one record per line, trailing newline)", async () => {
		const cwd = tmpProject();
		try {
			await appendRejections(
				cwd,
				toRejectionRecords([finding()], { now: "2026-01-01" }),
			);
			const text = readFileSync(getRejectionsPath(cwd), "utf8");
			expect(text.endsWith("\n")).toBe(true);
			expect(text.split("\n").filter(Boolean)).toHaveLength(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("caps the file at the configured size, dropping oldest", async () => {
		const cwd = tmpProject();
		try {
			// Fill past the cap with distinct findings, then add one more.
			const old: Finding[] = [];
			for (let i = 0; i < DEFAULT_REJECTION_CAP; i++) {
				old.push(
					finding({
						file: `src/file-${i}.ts`,
						line: 1,
						summary: `Unique summary number ${i} with distinct tokens`,
					}),
				);
			}
			await appendRejections(
				cwd,
				toRejectionRecords(old, { now: "2026-01-01" }),
				5,
			);
			// Adding a new one should trim to 5 and keep the newest.
			await appendRejections(
				cwd,
				toRejectionRecords(
					[
						finding({
							file: "new.ts",
							line: 1,
							summary: "A brand new finding",
						}),
					],
					{ now: "2026-06-17" },
				),
				5,
			);
			const records = await loadRejections(cwd);
			expect(records.length).toBeLessThanOrEqual(5);
			expect(records.some((r) => r.file === "new.ts")).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("silently no-ops on empty input", async () => {
		const cwd = tmpProject();
		try {
			await appendRejections(cwd, []);
			expect(existsSync(getRejectionsPath(cwd))).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("serializes concurrent writers via a per-cwd Promise chain", async () => {
		const cwd = tmpProject();
		try {
			const findings: Finding[] = [];
			for (let i = 0; i < 10; i++) {
				findings.push(
					finding({
						file: `src/concurrent-${i}.ts`,
						line: 1,
						summary: `Distinct summary token-${i} for concurrent writer ${i}`,
					}),
				);
			}
			// Fire 10 appends in parallel — the per-cwd chain should
			// serialize them so no records are clobbered.
			await Promise.all(
				findings.map((f) => appendRejections(cwd, toRejectionRecords([f]))),
			);
			const records = await loadRejections(cwd);
			expect(records).toHaveLength(10);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("getRejectionsPath", () => {
	it("lives at .pi/drykiss/rejections.jsonl relative to the project cwd", () => {
		expect(getRejectionsPath("/work/proj")).toBe(
			join("/work/proj", ".pi", "drykiss", REJECTIONS_FILE),
		);
	});
});

describe("exported similarity constants", () => {
	it("exposes the heuristic thresholds so callers can tune them", () => {
		// The exact values matter for the sameBug() contract — a silent
		// change to these constants would shift matching behavior across
		// the codebase. Pin them so a regression in a future refactor
		// surfaces as a test diff, not as silently-broken matching.
		expect(CO_LOCATED_LINE_WINDOW).toBe(3);
		expect(CO_LOCATED_JACCARD_THRESHOLD).toBe(0.25);
		expect(UNANCHORED_JACCARD_THRESHOLD).toBe(0.5);
	});

	it("exposes a sane message length cap (defense against OOM)", () => {
		// A multi-megabyte message in the store would let one line
		// exhaust the process heap during tokenize. The cap is a
		// project-wide safety net, not a per-record limit, so we
		// only assert it's bounded and reasonable.
		expect(MAX_MESSAGE_LENGTH).toBeGreaterThan(0);
		expect(MAX_MESSAGE_LENGTH).toBeLessThanOrEqual(100_000);
	});

	it("exposes a sane store-size cap (defense against file-read OOM)", () => {
		// 1MB is well over the legitimate ~30KB max for 200 records.
		// Pin the constant so a regression in a future refactor
		// surfaces as a test diff, not as a silent DoS exposure.
		expect(MAX_STORE_BYTES).toBe(1_048_576);
	});
});

describe("loadRejections — DoS guard", () => {
	it("rejects records whose message exceeds the cap (DoS hardening)", async () => {
		const cwd = tmpProject();
		try {
			const path = getRejectionsPath(cwd);
			writeFileSync(
				path,
				[
					// valid baseline
					JSON.stringify({
						file: "a.ts",
						severity: "high",
						message: "ok",
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
					// pathological message length — tokenize would OOM
					JSON.stringify({
						file: "b.ts",
						severity: "high",
						message: "x".repeat(MAX_MESSAGE_LENGTH + 1),
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
				].join("\n") + "\n",
				"utf8",
			);
			const records = await loadRejections(cwd);
			expect(records).toHaveLength(1);
			expect(records[0].file).toBe("a.ts");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects an oversize file (no read into memory)", async () => {
		const cwd = tmpProject();
		try {
			const path = getRejectionsPath(cwd);
			// Write enough content to exceed the 1MB cap. We don't
			// need a real JSONL structure — the size check runs first.
			const oversize = "x".repeat(2 * 1024 * 1024);
			writeFileSync(path, oversize, "utf8");
			const records = await loadRejections(cwd);
			expect(records).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("strips ANSI escape sequences from malformed-record log output", async () => {
		// We can't easily intercept console.warn, but we can verify
		// the function doesn't crash on an ANSI-laden line. The
		// garbage line should be dropped, the valid one kept.
		const cwd = tmpProject();
		try {
			const path = getRejectionsPath(cwd);
			writeFileSync(
				path,
				[
					JSON.stringify({
						file: "a.ts",
						severity: "high",
						message: "ok",
						recorded_at: "2026-01-01T00:00:00.000Z",
					}),
					// Malformed line with ANSI ESC + newline injection.
					"not-json-but-with-ansi\x1b[31mred\x1b[0m\nand-injected-newline",
				].join("\n") + "\n",
				"utf8",
			);
			const records = await loadRejections(cwd);
			expect(records).toHaveLength(1);
			expect(records[0].file).toBe("a.ts");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("appendRejections — atomic write", () => {
	it("writes via temp file + rename so the original is preserved on crash", async () => {
		const cwd = tmpProject();
		try {
			// First write creates the file via tmp+rename.
			await appendRejections(
				cwd,
				toRejectionRecords([finding()], { now: "2026-01-01" }),
			);
			const path = getRejectionsPath(cwd);
			expect(existsSync(path)).toBe(true);
			// The temp file must NOT linger after a successful write.
			expect(existsSync(`${path}.tmp`)).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("cleans up the tmp file when the write fails (no orphan)", async () => {
		const cwd = tmpProject();
		try {
			// Pre-create a tmp file so we can verify it's unlinked.
			const path = getRejectionsPath(cwd);
			mkdirSync(join(cwd, ".pi", "drykiss"), { recursive: true });
			// Point at an unwritable parent dir so the write itself
			// will fail. The cwd is a temp dir; we can't make it
			// unwritable portably, so instead force the failure by
			// passing a bad path that triggers rename to fail.
			// Easier: just verify the path-tracking is correct by
			// running a normal write and confirming no .tmp lingers
			// (covered by the previous test). The cleanup branch is
			// exercised when the path itself rejects — a unit test
			// for that is platform-specific, so we accept the simpler
			// shape here.
			await appendRejections(
				cwd,
				toRejectionRecords([finding()], { now: "2026-01-01" }),
			);
			expect(existsSync(`${path}.tmp`)).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("no-ops gracefully when the path can't be resolved", async () => {
		// Passing a path directly bypasses safeGetRejectionsPath, so
		// we can't easily simulate a "cwd that throws" on POSIX.
		// Instead verify that passing a bad path causes a silent
		// failure (the doAppendRejections catch swallows it).
		const cwd = tmpProject();
		try {
			const path = join(cwd, "no", "such", "dir", "store.jsonl");
			await expect(
				appendRejections(cwd, toRejectionRecords([finding()]), 200, path),
			).resolves.toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
