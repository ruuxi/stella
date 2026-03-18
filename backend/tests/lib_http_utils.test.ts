import { describe, test, expect } from "bun:test";
import {
  normalizeClientAddressKey,
  MAX_CLIENT_ADDRESS_KEY_LENGTH,
  CLIENT_ADDRESS_KEY_PATTERN,
} from "../convex/lib/http_utils";

describe("normalizeClientAddressKey", () => {
  test("normalizes valid IPv4 addresses", () => {
    expect(normalizeClientAddressKey("192.168.1.1")).toBe("192.168.1.1");
  });

  test("normalizes valid IPv6 addresses", () => {
    expect(normalizeClientAddressKey("::1")).toBe("::1");
  });

  test("trims and lowercases", () => {
    expect(normalizeClientAddressKey("  192.168.1.1  ")).toBe("192.168.1.1");
    expect(normalizeClientAddressKey("FE80::1")).toBe("fe80::1");
  });

  test("returns null for null input", () => {
    expect(normalizeClientAddressKey(null)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(normalizeClientAddressKey("")).toBeNull();
    expect(normalizeClientAddressKey("   ")).toBeNull();
  });

  test("returns null for too-long values", () => {
    expect(normalizeClientAddressKey("1".repeat(MAX_CLIENT_ADDRESS_KEY_LENGTH + 1))).toBeNull();
  });

  test("returns null for invalid characters", () => {
    expect(normalizeClientAddressKey("not-an-ip")).toBeNull();
    expect(normalizeClientAddressKey("192.168.1.1; DROP TABLE")).toBeNull();
  });
});

describe("CLIENT_ADDRESS_KEY_PATTERN", () => {
  test("matches valid hex/dot/colon patterns", () => {
    expect(CLIENT_ADDRESS_KEY_PATTERN.test("192.168.1.1")).toBe(true);
    expect(CLIENT_ADDRESS_KEY_PATTERN.test("::1")).toBe(true);
    expect(CLIENT_ADDRESS_KEY_PATTERN.test("fe80::1")).toBe(true);
  });
});
