/**
 * Compile a list of glob patterns into regex matchers.
 * Silently skips invalid patterns so a single bad pattern doesn't crash the review.
 */
const MAX_GLOB_PATTERN_LENGTH = 512;

export function compileGlobMatchers(patterns: readonly string[]): RegExp[] {
	const matchers: RegExp[] = [];
	for (const p of patterns) {
		if (p.length > MAX_GLOB_PATTERN_LENGTH) continue;
		try {
			matchers.push(globToRegex(p));
		} catch {
			// Skip invalid patterns
		}
	}
	return matchers;
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

/** Convert a simple glob pattern to a regex (supports **, *, ?). */
function globToRegex(pattern: string): RegExp {
	// Normalize backslashes to forward slashes for cross-platform support
	const normalized = pattern.replaceAll(/\\/g, "/");
	let regex = "^";
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "*") {
			// ** matches any number of path segments
			if (normalized[i + 1] === "*") {
				regex += ".*";
				i++; // skip second *
			} else {
				regex += "[^/]*";
			}
		} else if (ch === "?") {
			regex += "[^/]";
		} else if (ch === ".") {
			regex += "\\.";
		} else if (/[.\\+^${}()|[\]/]/.test(ch)) {
			// Escape any regex-special characters that aren't glob wildcards
			regex += `\\${ch}`;
		} else {
			regex += ch;
		}
	}
	regex += "$";
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	// Safe: literals are escaped, glob wildcards expand to linear fragments,
	// and compileGlobMatchers caps pattern length before calling this helper.
	return new RegExp(regex); // nosemgrep
}
