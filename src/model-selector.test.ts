import { describe, it, expect } from "vitest";
import { isQuotaError, isAuthError } from "./model-selector.js";

describe("isQuotaError", () => {
  it("detects rate limit errors", () => {
    expect(isQuotaError(new Error("Rate limit exceeded"))).toBe(true);
    expect(isQuotaError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isQuotaError(new Error("insufficient_quota"))).toBe(true);
    expect(isQuotaError(new Error("API is overloaded"))).toBe(true);
  });

  it("detects quota keywords", () => {
    expect(isQuotaError(new Error("You have exceeded your QUOTA"))).toBe(true);
    expect(isQuotaError(new Error("Capacity reached"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isQuotaError(new Error("Network timeout"))).toBe(false);
    expect(isQuotaError(new Error("File not found"))).toBe(false);
    expect(isQuotaError(new Error("Syntax error"))).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isQuotaError("string")).toBe(false);
    expect(isQuotaError(42)).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe("isAuthError", () => {
  it("detects API key errors", () => {
    expect(isAuthError(new Error("Invalid API key"))).toBe(true);
    expect(isAuthError(new Error("Authentication failed"))).toBe(true);
    expect(isAuthError(new Error("Unauthorized: 401"))).toBe(true);
    expect(isAuthError(new Error("Forbidden: 403"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAuthError(new Error("Network timeout"))).toBe(false);
    expect(isAuthError(new Error("Rate limit"))).toBe(false);
  });
});
