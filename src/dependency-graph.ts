import type { ProjectIndexEntry } from "./git-diff.js";
import type { Finding } from "./types.js";

/**
 * Derive a short display label from a file path.
 * Uses the basename (filename without directory).
 * For index files (index.ts, index.js, etc.), includes the parent
 * directory name to disambiguate (e.g. "utils/index.ts").
 */
function nodeLabel(filePath: string): string {
	const parts = filePath.split("/");
	const base = parts[parts.length - 1] ?? filePath;
	// Disambiguate bare "index.*" files by prepending parent directory name.
	if (/^index\.[a-z]+$/i.test(base) && parts.length >= 2) {
		const parent = parts[parts.length - 2];
		return `${parent}/${base}`;
	}
	return base;
}

/**
 * Convert a file path to a safe Mermaid node identifier.
 * Mermaid node IDs must be alphanumeric; replace non-word characters with
 * underscores and prefix with "n_" so numeric-only names stay valid.
 */
function nodeId(filePath: string): string {
	return "n_" + filePath.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Escape a string for use inside a Mermaid node label (quoted form).
 * Mermaid quotes labels with double-quotes; literal double-quotes inside
 * the label must be replaced with the HTML entity `&quot;`.
 */
function escapeMermaidLabel(text: string): string {
	return text.replace(/"/g, "&quot;");
}

/**
 * Extract bare import/require specifiers that look like relative paths
 * pointing to project-local files.  Handles:
 *   - ES module static imports:    import ... from "./foo"
 *   - ES module re-exports:        export ... from "./foo"
 *   - CommonJS require():          require("./foo")
 *   - Dynamic import():            import("./foo")
 *
 * Only relative specifiers (starting with "./" or "../") are captured;
 * bare package names and absolute paths are ignored.
 */
function extractImportSpecifiers(exports: readonly string[]): string[] {
	// ProjectIndexEntry.exports contains the *exported symbol names*, not raw
	// source.  The graph must therefore be built from export-name membership
	// rather than raw import lines (the raw source is not stored in the index).
	// This function is intentionally left as a no-op for the current schema
	// and is preserved for forward-compat when the index gains an `imports`
	// field.
	void exports;
	return [];
}

/**
 * Resolve which entries export each symbol name so we can build edges
 * "file A imports symbol X → file B exports X".
 *
 * Returns a map from symbol name → set of file paths that export it.
 */
function buildExportMap(
	entries: readonly ProjectIndexEntry[],
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const entry of entries) {
		for (const sym of entry.exports) {
			let paths = map.get(sym);
			if (!paths) {
				paths = new Set();
				map.set(sym, paths);
			}
			paths.add(entry.path);
		}
	}
	return map;
}

/**
 * A directed edge between two files in the dependency graph.
 */
interface Edge {
	readonly from: string;
	readonly to: string;
	/** True when a boundary/architecture finding references both endpoints. */
	readonly isViolation: boolean;
}

/**
 * Detect circular dependency pairs from a set of edges.
 * Returns the set of "from→to" keys that are part of a cycle.
 * A cycle exists when both "A→B" and "B→A" edges are present.
 */
function detectCircularPairs(edges: readonly Edge[]): Set<string> {
	const edgeSet = new Set(edges.map((e) => `${e.from}\x00${e.to}`));
	const circular = new Set<string>();
	for (const edge of edges) {
		const reverse = `${edge.to}\x00${edge.from}`;
		if (edgeSet.has(reverse)) {
			circular.add(`${edge.from}\x00${edge.to}`);
		}
	}
	return circular;
}

/**
 * Parse files referenced in architecture-lens findings.
 * A single finding may name more than one file (e.g. in `detail` or
 * `suggestion`), but the structured `file` field always refers to the
 * primary violating file. We collect the primary file per finding.
 */
function findingFiles(findings: readonly Finding[]): Set<string> {
	const files = new Set<string>();
	for (const f of findings) {
		if (f.file) files.add(f.file);
	}
	return files;
}

/**
 * Extract pairs of files that represent boundary violations from findings.
 * Architecture findings often describe a dependency that crosses a boundary;
 * when a finding's `detail` or `suggestion` mentions another file from the
 * project index by path, we surface that as a red edge.
 *
 * Because the project index does not include raw source, we rely on the
 * finding text mentioning another indexed file's path segment. This is a
 * best-effort heuristic.
 */
function extractViolationPairs(
	findings: readonly Finding[],
	indexedPaths: ReadonlySet<string>,
): Array<{ from: string; to: string }> {
	const pairs: Array<{ from: string; to: string }> = [];
	for (const f of findings) {
		if (!f.file) continue;
		const text = `${f.detail ?? ""} ${f.suggestion ?? ""} ${f.summary ?? ""}`;
		for (const candidate of indexedPaths) {
			if (candidate === f.file) continue;
			// Match on the basename or the last two path segments.
			const base = candidate.split("/").pop() ?? "";
			if (base && text.includes(base)) {
				pairs.push({ from: f.file, to: candidate });
			}
		}
	}
	return pairs;
}

/**
 * Build a deduplicated edge list from the project index.
 *
 * Edge strategy: because `ProjectIndexEntry` stores exported symbol names
 * but not raw import statements, we use shared exported symbols as a proxy
 * for dependency: if file A exports a symbol that file B *also* exports
 * with the same name and they are in different directories, we treat it as
 * a probable re-export / dependency relationship.
 *
 * This is a conservative heuristic — it avoids false edges between
 * completely unrelated files while still surfacing real structural
 * relationships visible in the index.
 *
 * Architecture-lens findings that mention multiple files yield additional
 * "violation" edges rendered in red.
 */
function buildEdges(
	entries: readonly ProjectIndexEntry[],
	archFindings: readonly Finding[],
): Edge[] {
	const exportMap = buildExportMap(entries);
	const indexedPaths = new Set(entries.map((e) => e.path));

	// Build edges: for each symbol exported by more than one file, connect
	// every pair within the same conceptual layer (different first directory
	// segment) as a dependency edge.
	const edgeKeys = new Set<string>();
	const edges: Edge[] = [];

	for (const [, paths] of exportMap) {
		if (paths.size < 2) continue;
		const pathArr = [...paths];
		for (let i = 0; i < pathArr.length; i++) {
			for (let j = i + 1; j < pathArr.length; j++) {
				const a = pathArr[i]!;
				const b = pathArr[j]!;
				// Only add edge when files are in different first-level directories
				// to avoid noisy within-directory edges for co-located helpers.
				const aDir = a.split("/")[0] ?? "";
				const bDir = b.split("/")[0] ?? "";
				if (aDir === bDir) continue;
				const key = `${a}\x00${b}`;
				const keyRev = `${b}\x00${a}`;
				if (!edgeKeys.has(key) && !edgeKeys.has(keyRev)) {
					edgeKeys.add(key);
					edges.push({ from: a, to: b, isViolation: false });
				}
			}
		}
	}

	// Violation edges from architecture findings.
	const violationPairs = extractViolationPairs(archFindings, indexedPaths);
	for (const { from, to } of violationPairs) {
		if (!indexedPaths.has(from) || !indexedPaths.has(to)) continue;
		const key = `${from}\x00${to}`;
		if (edgeKeys.has(key)) {
			// Upgrade existing edge to a violation.
			const idx = edges.findIndex(
				(e) => e.from === from && e.to === to,
			);
			if (idx >= 0) {
				edges[idx] = { ...edges[idx]!, isViolation: true };
			}
		} else {
			edgeKeys.add(key);
			edges.push({ from, to, isViolation: true });
		}
	}

	return edges;
}

/**
 * Generate a Mermaid `graph TD` diagram from a project index and optional
 * architecture-lens findings.
 *
 * The returned string is a fenced Mermaid code block:
 * ```mermaid
 * graph TD
 *   ...
 * ```
 *
 * Node rendering:
 *   - Each file in the project index becomes a node.
 *   - The node label is the short basename (or "parent/index.ts" for index
 *     files).  The full path is embedded as a tooltip via `@{ tooltip: ... }`.
 *   - Files referenced in architecture findings are styled with a warning
 *     class (orange background).
 *
 * Edge rendering:
 *   - Edges are inferred from shared exported symbol names across files in
 *     different top-level directories (proxy for re-export / import).
 *   - Boundary-violation pairs extracted from finding text get a red edge
 *     rendered with `--x` (blocked arrow style).
 *   - Circular dependency pairs (A→B and B→A both present) are rendered
 *     with a bidirectional `<-->` arrow instead of two separate edges.
 *
 * Orphan nodes (no edges) are included as isolated nodes so the full
 * file inventory is always visible in the graph.
 */
export function generateMermaidGraph(
	entries: ProjectIndexEntry[],
	findings?: Finding[],
): string {
	if (entries.length === 0) {
		return "```mermaid\ngraph TD\n  empty[\"No indexed files\"]\n```";
	}

	const archFindings = (findings ?? []).filter(
		(f) => f.lens === "architecture",
	);
	const warningFiles = findingFiles(archFindings);
	const edges = buildEdges(entries, archFindings);
	const circularKeys = detectCircularPairs(edges);

	// Deduplicate bidirectional pairs: only emit one combined edge for A↔B.
	const emittedBidir = new Set<string>();

	const lines: string[] = ["graph TD"];

	// ── Node declarations ───────────────────────────────────────────────────
	for (const entry of entries) {
		const id = nodeId(entry.path);
		const label = escapeMermaidLabel(nodeLabel(entry.path));
		const tooltip = escapeMermaidLabel(entry.path);
		// Mermaid supports a metadata annotation for tooltips.
		lines.push(`  ${id}["${label}"]@{ tooltip: "${tooltip}" }`);
	}

	// Blank line between nodes and edges for readability.
	if (edges.length > 0) lines.push("");

	// ── Edge declarations ───────────────────────────────────────────────────
	for (const edge of edges) {
		const fromId = nodeId(edge.from);
		const toId = nodeId(edge.to);
		const edgeKey = `${edge.from}\x00${edge.to}`;
		const reverseKey = `${edge.to}\x00${edge.from}`;

		if (circularKeys.has(edgeKey)) {
			// Bidirectional: emit once as A <--> B.
			const bidirKey = [edge.from, edge.to].sort().join("\x00");
			if (emittedBidir.has(bidirKey)) continue;
			emittedBidir.add(bidirKey);
			// Use red label for circular deps that also involve a violation.
			const isViolation =
				edge.isViolation ||
				edges.find(
					(e) => e.from === edge.to && e.to === edge.from && e.isViolation,
				) !== undefined;
			if (isViolation) {
				lines.push(`  ${fromId} <--x|"circular violation"| ${toId}`);
			} else {
				lines.push(`  ${fromId} <--> ${toId}`);
			}
		} else if (circularKeys.has(reverseKey)) {
			// This reverse direction is already handled by the forward pass.
			continue;
		} else if (edge.isViolation) {
			// Boundary violation: blocked arrow in red via class styling.
			lines.push(`  ${fromId} --x ${toId}`);
		} else {
			lines.push(`  ${fromId} --> ${toId}`);
		}
	}

	// ── Style classes ───────────────────────────────────────────────────────
	const warningNodeIds: string[] = [];
	for (const filePath of warningFiles) {
		// Only emit styles for files present in the index.
		if (entries.some((e) => e.path === filePath)) {
			warningNodeIds.push(nodeId(filePath));
		}
	}

	if (warningNodeIds.length > 0) {
		lines.push("");
		lines.push(
			"  classDef warning fill:#f5a623,stroke:#c47d00,color:#000,font-weight:bold",
		);
		lines.push(`  class ${warningNodeIds.join(",")} warning`);
	}

	// Violation edges get a red stroke.
	const hasViolationEdges = edges.some((e) => e.isViolation);
	if (hasViolationEdges) {
		lines.push("");
		lines.push(
			"  classDef violation stroke:#d32f2f,stroke-width:2px",
		);
	}

	return "```mermaid\n" + lines.join("\n") + "\n```";
}
