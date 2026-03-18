import { describe, test, expect } from "bun:test";
import { LINK_CODE_ALPHABET } from "../convex/channels/link_codes";

describe("LINK_CODE_ALPHABET", () => {
  test("contains uppercase letters and digits", () => {
    for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      expect(LINK_CODE_ALPHABET).toContain(char);
    }
  });

  test("has 36 characters", () => {
    expect(LINK_CODE_ALPHABET.length).toBe(36);
  });

  test("does not contain lowercase letters", () => {
    for (const char of "abcdefghijklmnopqrstuvwxyz") {
      expect(LINK_CODE_ALPHABET).not.toContain(char);
    }
  });

  test("does not contain special characters", () => {
    for (const char of "!@#$%^&*()-_=+") {
      expect(LINK_CODE_ALPHABET).not.toContain(char);
    }
  });
});
