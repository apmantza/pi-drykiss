import path from "path";
import { defineConfig } from "vitest/config";

// Peer deps are not installed locally; mock them so tests resolve.
const peerMock = path.resolve(__dirname, "vitest-peer-mock.js");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": peerMock,
      "@earendil-works/pi-ai": peerMock,
      "@earendil-works/pi-tui": peerMock,
    },
  },
});
