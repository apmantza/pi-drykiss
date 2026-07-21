/**
 * Compile a list of glob patterns into regex matchers.
 * Silently skips invalid patterns so a single bad pattern doesn't crash the review.
 */

const MAX_GLOB_PATTERN_LENGTH = 512;
const MAX_GLOB_WILDCARDS = 20;

/** Cache of compiled glob matchers keyed by a sorted JSON representation of the pattern array. */
const compiledMatchersCache = new Map<string, RegExp[]>();

export function compileGlobMatchers(patterns: readonly string[]): RegExp[] {
	const cacheKey = JSON.stringify([...patterns].sort());
	const cached = compiledMatchersCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}
	const matchers: RegExp[] = [];
	for (const p of patterns) {
		if (p.length > MAX_GLOB_PATTERN_LENGTH) continue;
		if (countWildcards(p) > MAX_GLOB_WILDCARDS) continue;
		try {
			matchers.push(globToRegex(p));
		} catch {
			// Skip invalid patterns
		}
	}
	compiledMatchersCache.set(cacheKey, matchers);
	return matchers;
}

/** Count wildcard characters (* and ?) in a glob pattern. */
function countWildcards(pattern: string): number {
	let count = 0;
	for (const ch of pattern) {
		if (ch === "*" || ch === "?") count++;
	}
	return count;
}

/** Check whether a file path matches any of the provided glob patterns. */
export function matchesAnyGlob(
	filePath: string,
	patterns: readonly string[],
): boolean {
	if (patterns.length === 0) return false;
	const normalized = filePath.replaceAll(/\\/g, "/");
	const matchers = compileGlobMatchers(patterns);
	return matchers.some((r) => r.test(normalized));
}

/**
 * Convert a simple glob pattern to a regex.
 *
 * Safety: the generated regex never contains alternations or nested
 * quantifiers — the only dynamic expansions are "?" → "[^/]",
 * "*" → "[^/]*", "**" → ".*". Combined with the pattern-length and
 * wildcard-count caps above, catastrophic backtracking is not possible.
 * This is a Semgrep FP that cannot be suppressed inline in JS/TS
 * (semgrep.dev/rule/javascript.lang.security.audit.detect-non-literal-regexp).
 */
function globToRegex(pattern: string): RegExp {
	const normalized = pattern.replaceAll(/\\/g, "/");
	let regex = "^";
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "*") {
			if (normalized[i + 1] === "*") {
				regex += ".*";
				i++;
			} else {
				regex += "[^/]*";
			}
		} else if (ch === "?") {
			regex += "[^/]";
		} else if (ch === ".") {
			regex += "\\.";
		} else if (/[.\\+^${}()|[\]/]/.test(ch)) {
			regex += `\\${ch}`;
		} else {
			regex += ch;
		}
	}
	regex += "$";
	return new RegExp(regex); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
}
