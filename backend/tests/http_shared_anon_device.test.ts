import { describe, test, expect } from "bun:test";
import {
  getAnonDeviceId,
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "../convex/http_shared/anon_device";

describe("getAnonDeviceId", () => {
  const makeRequest = (deviceId: string | null): Request => {
    const headers = new Headers();
    if (deviceId !== null) {
      headers.set("X-Device-ID", deviceId);
    }
    return new Request("https://example.com", { headers });
  };

  test("extracts device ID from header", () => {
    expect(getAnonDeviceId(makeRequest("device-123"))).toBe("device-123");
  });

  test("trims whitespace", () => {
    expect(getAnonDeviceId(makeRequest("  device-123  "))).toBe("device-123");
  });

  test("returns null for missing header", () => {
    expect(getAnonDeviceId(makeRequest(null))).toBeNull();
  });

  test("returns null for empty header", () => {
    expect(getAnonDeviceId(makeRequest(""))).toBeNull();
    expect(getAnonDeviceId(makeRequest("   "))).toBeNull();
  });

  test("returns null for too-long device IDs", () => {
    expect(getAnonDeviceId(makeRequest("a".repeat(256)))).toBeNull();
  });

  test("accepts device IDs up to 255 chars", () => {
    expect(getAnonDeviceId(makeRequest("a".repeat(255)))).toBe("a".repeat(255));
  });
});

describe("isAnonDeviceHashSaltMissingError", () => {
  test("detects missing salt errors", () => {
    const err = new Error("Missing ANON_DEVICE_ID_HASH_SALT environment variable");
    expect(isAnonDeviceHashSaltMissingError(err)).toBe(true);
  });

  test("rejects unrelated errors", () => {
    expect(isAnonDeviceHashSaltMissingError(new Error("Something else"))).toBe(false);
  });

  test("rejects non-Error values", () => {
    expect(isAnonDeviceHashSaltMissingError("not an error")).toBe(false);
    expect(isAnonDeviceHashSaltMissingError(null)).toBe(false);
  });
});
