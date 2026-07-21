/**
 * review-cache.ts — Disk-backed cache for lens review results.
 *
 * Cache key: SHA-256 of (file content concat + lens system prompt + model ID).
 * Storage:   JSON files in ~/.pi/drykiss/cache/<hash>.json
 * TTL:       7 days (entries older than 7 days are treated as stale).
 * Max size:  100 entries (LRU eviction by cachedAt when limit is exceeded).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalBaseDir } from "./constants.js";
import type { Finding } from "./types.js";

const CACHE_DIR_NAME = "cache";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_MAX_ENTRIES = 100;

export interface CacheEntry {
	findings: Finding[];
	cachedAt: string;
	lens: string;
	model: string;
}

function getCacheDir(): string {
	return join(getGlobalBaseDir(), CACHE_DIR_NAME);
}

function getCachePath(hash: string): string {
	return join(getCacheDir(), `${hash}.json`);
}

/**
 * Compute the cache key for a lens run.
 * Input: concatenation of file contents, the lens system prompt, and the model ID.
 */
export function computeCacheKey(
	fileContents: string,
	systemPrompt: string,
	modelId: string,
): string {
	return createHash("sha256")
		.update(fileContents)
		.update("\x00")
		.update(systemPrompt)
		.update("\x00")
		.update(modelId)
		.digest("hex");
}

/**
 * Retrieve a cached result for the given key.
 * Returns undefined when there is no entry, the entry is stale (> 7 days),
 * or the file cannot be read.
 */
export async function getCachedResult(
	key: string,
): Promise<Finding[] | undefined> {
	try {
		const text = await readFile(getCachePath(key), "utf8");
		const entry = JSON.parse(text) as CacheEntry;
		if (!entry || !Array.isArray(entry.findings) || !entry.cachedAt) {
			return undefined;
		}
		const age = Date.now() - new Date(entry.cachedAt).getTime();
		if (age > CACHE_TTL_MS) {
			// Stale — delete silently and treat as a miss.
			unlink(getCachePath(key)).catch(() => {});
			return undefined;
		}
		return entry.findings;
	} catch {
		return undefined;
	}
}

/**
 * Store a lens result in the cache.
 * Evicts the oldest entries (by cachedAt) when the store exceeds CACHE_MAX_ENTRIES.
 */
export async function setCachedResult(
	key: string,
	findings: Finding[],
	metadata: { lens: string; model: string },
): Promise<void> {
	try {
		const cacheDir = getCacheDir();
		await mkdir(cacheDir, { recursive: true });

		const entry: CacheEntry = {
			findings,
			cachedAt: new Date().toISOString(),
			lens: metadata.lens,
			model: metadata.model,
		};

		await writeFile(getCachePath(key), JSON.stringify(entry, null, 2), "utf8");

		// Evict stale and excess entries.
		await evict(cacheDir);
	} catch {
		// Cache writes are best-effort; never break review flow.
	}
}

/**
 * Remove all cached entries.
 */
export async function clearCache(): Promise<void> {
	const cacheDir = getCacheDir();
	try {
		const files = await readdir(cacheDir);
		await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map((f) => unlink(join(cacheDir, f)).catch(() => {})),
		);
	} catch {
		// Directory may not exist yet.
	}
}

/**
 * Evict stale entries (TTL exceeded) and, if the store still exceeds
 * CACHE_MAX_ENTRIES, drop the oldest by cachedAt (LRU).
 */
async function evict(cacheDir: string): Promise<void> {
	try {
		const files = await readdir(cacheDir);
		const jsonFiles = files.filter((f) => f.endsWith(".json"));
		if (jsonFiles.length <= CACHE_MAX_ENTRIES) return;

		// Read cachedAt from each entry to sort by age.
		const entries: { file: string; cachedAt: number }[] = [];
		for (const file of jsonFiles) {
			try {
				const text = await readFile(join(cacheDir, file), "utf8");
				const parsed = JSON.parse(text) as Partial<CacheEntry>;
				const cachedAt = parsed.cachedAt
					? new Date(parsed.cachedAt).getTime()
					: 0;
				entries.push({ file, cachedAt });
			} catch {
				// Unreadable file — mark as oldest so it gets evicted first.
				entries.push({ file, cachedAt: 0 });
			}
		}

		// Sort oldest-first (ascending cachedAt).
		entries.sort((a, b) => a.cachedAt - b.cachedAt);

		// Drop entries until we are within the limit.
		const excess = entries.length - CACHE_MAX_ENTRIES;
		await Promise.all(
			entries
				.slice(0, excess)
				.map(({ file }) => unlink(join(cacheDir, file)).catch(() => {})),
		);
	} catch {
		// Eviction is best-effort.
	}
}
