import { describe, expect, it } from "vitest";

import { safeInternalPath } from "@/routes";

/**
 * `maybeCallbackUrl` reaches `redirectTo` for credentials and Google sign-in.
 * The helper must only ever hand back a same-origin absolute path.
 */
describe("safeInternalPath", () => {
  it("accepts internal absolute paths", () => {
    expect(safeInternalPath("/")).toBe("/");
    expect(safeInternalPath("/products/widget-1?tab=reviews#top")).toBe(
      "/products/widget-1?tab=reviews#top"
    );
  });

  it.each([
    ["protocol-relative URL", "//evil.example"],
    ["backslash-smuggled URL", "/\\evil"],
    ["absolute https URL", "https://evil.example/path"],
    ["absolute http URL", "http://evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["bare relative path", "products/widget-1"],
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(safeInternalPath(value)).toBeUndefined();
  });

  it("treats an encoded // as a path, never as an external origin", () => {
    // The browser resolves this as a same-origin path; the encoded slashes are
    // not decoded into an authority by redirect handling, so it stays internal.
    expect(safeInternalPath("/%2F%2Fevil")).toBe("/%2F%2Fevil");
  });
});
