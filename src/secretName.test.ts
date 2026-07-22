import { describe, it, expect } from "vitest";
import { resolveSecretName } from "./secretName";

const PREFIX = "claude-webasto/prod/token";

describe("resolveSecretName", () => {
  it("appends a valid tokenId to the prefix", () => {
    expect(resolveSecretName(PREFIX, "alice")).toBe(`${PREFIX}/alice`);
    expect(resolveSecretName(PREFIX, "bob-2")).toBe(`${PREFIX}/bob-2`);
  });

  it("returns the bare prefix when tokenId is undefined (legacy)", () => {
    expect(resolveSecretName(PREFIX)).toBe(PREFIX);
    expect(resolveSecretName(PREFIX, undefined)).toBe(PREFIX);
  });

  it("throws on an empty-string tokenId", () => {
    expect(() => resolveSecretName(PREFIX, "")).toThrow(/Invalid tokenId/);
  });

  it("throws on path-traversal, uppercase, and symbol ids", () => {
    for (const bad of ["../evil", "Alice", "a b", "a/b", "a_b", "a.b"]) {
      expect(() => resolveSecretName(PREFIX, bad)).toThrow(/Invalid tokenId/);
    }
  });
});
