import { describe, test, expect } from "bun:test";
import {
  base64UrlDecode,
  constantTimeEqual,
  bytesToHex,
  hexToUint8Array,
  hashSha256Hex,
} from "../convex/lib/crypto_utils";

describe("base64UrlDecode", () => {
  test("decodes standard base64url strings", () => {
    // "Hello" in base64url is "SGVsbG8"
    const result = base64UrlDecode("SGVsbG8");
    expect(new TextDecoder().decode(result)).toBe("Hello");
  });

  test("handles base64url characters (- and _)", () => {
    // base64url uses - instead of + and _ instead of /
    // Encode bytes [0x6b, 0xf7, 0xbe] → standard base64 "a/e+" → base64url "a_e-"
    const result = base64UrlDecode("a_e-");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(3);
  });

  test("handles strings needing padding", () => {
    // "A" in base64 is "QQ==" — base64url drops the padding
    const result = base64UrlDecode("QQ");
    expect(result[0]).toBe(65); // ASCII 'A'
  });

  test("decodes empty string", () => {
    const result = base64UrlDecode("");
    expect(result.length).toBe(0);
  });
});

describe("constantTimeEqual", () => {
  test("returns true for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  test("returns false for different strings of same length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("aaa", "bbb")).toBe(false);
  });

  test("returns false for different lengths", () => {
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("a", "ab")).toBe(false);
  });

  test("handles hex digest strings", () => {
    const a = "abcdef0123456789abcdef0123456789";
    const b = "abcdef0123456789abcdef0123456789";
    const c = "abcdef0123456789abcdef0123456780";
    expect(constantTimeEqual(a, b)).toBe(true);
    expect(constantTimeEqual(a, c)).toBe(false);
  });
});

describe("bytesToHex", () => {
  test("converts bytes to lowercase hex", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 255]))).toBe("0001ff");
  });

  test("handles empty array", () => {
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });

  test("pads single-digit hex values", () => {
    expect(bytesToHex(new Uint8Array([0, 10, 15]))).toBe("000a0f");
  });
});

describe("hexToUint8Array", () => {
  test("converts hex string to bytes", () => {
    const result = hexToUint8Array("0001ff");
    expect(result).toEqual(new Uint8Array([0, 1, 255]));
  });

  test("handles empty string", () => {
    expect(hexToUint8Array("")).toEqual(new Uint8Array([]));
  });

  test("roundtrips with bytesToHex", () => {
    const original = new Uint8Array([10, 20, 30, 40, 255]);
    const hex = bytesToHex(original);
    const result = hexToUint8Array(hex);
    expect(result).toEqual(original);
  });
});

describe("hashSha256Hex", () => {
  test("returns 64-char hex string", async () => {
    const result = await hashSha256Hex("hello");
    expect(result.length).toBe(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test("produces known SHA-256 hash", async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const result = await hashSha256Hex("");
    expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("produces consistent results", async () => {
    const a = await hashSha256Hex("test");
    const b = await hashSha256Hex("test");
    expect(a).toBe(b);
  });

  test("produces different hashes for different inputs", async () => {
    const a = await hashSha256Hex("hello");
    const b = await hashSha256Hex("world");
    expect(a).not.toBe(b);
  });
});
