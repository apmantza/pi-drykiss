import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Peer deps are not installed locally; mock them so tests resolve.
const peerMock = fileURLToPath(
	new URL("./vitest-peer-mock.js", import.meta.url),
);

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["lcov", "text"],
			reportsDirectory: "coverage",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
		},
	},
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": peerMock,
			"@earendil-works/pi-ai/compat": peerMock,
			"@earendil-works/pi-ai": peerMock,
			"@earendil-works/pi-tui": peerMock,
		},
	},
});
