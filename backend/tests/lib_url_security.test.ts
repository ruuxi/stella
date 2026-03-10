import { describe, expect, test } from "bun:test";
import { normalizeSafeExternalUrl } from "../convex/lib/url_security";

describe("url_security", () => {
  test("upgrades public http URLs to https", () => {
    expect(normalizeSafeExternalUrl("http://example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  test("blocks localhost and private addresses", () => {
    expect(() => normalizeSafeExternalUrl("http://localhost:3000")).toThrow(
      "Private and local network targets are blocked.",
    );
    expect(() => normalizeSafeExternalUrl("https://192.168.1.10")).toThrow(
      "Private and local network targets are blocked.",
    );
  });

  test("blocks embedded credentials", () => {
    expect(() => normalizeSafeExternalUrl("https://user:pass@example.com")).toThrow(
      "Embedded URL credentials are not allowed.",
    );
  });
});
