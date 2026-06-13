import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve a target path and verify it stays inside the given root directory.
 * Both paths are resolved relative to the current working directory, then
 * normalized. Returns the resolved target path if it is within root.
 * Throws if the target escapes the root.
 */
export function assertPathInRoot(targetPath: string, rootPath: string): string {
	const rootResolved = resolve(rootPath);
	const targetResolved = resolve(rootPath, targetPath);
	const rel = relative(rootResolved, targetResolved);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Path resolved outside project root: ${targetResolved}`);
	}
	return targetResolved;
}
