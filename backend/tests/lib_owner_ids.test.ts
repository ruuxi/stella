import { describe, test, expect } from "bun:test";
import { BUILTIN_OWNER_ID } from "../convex/lib/owner_ids";

describe("BUILTIN_OWNER_ID", () => {
  test("is the expected constant value", () => {
    expect(BUILTIN_OWNER_ID).toBe("__builtin__");
  });

  test("is a non-empty string", () => {
    expect(typeof BUILTIN_OWNER_ID).toBe("string");
    expect(BUILTIN_OWNER_ID.length).toBeGreaterThan(0);
  });
});
