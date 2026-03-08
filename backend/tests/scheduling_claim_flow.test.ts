import { describe, test, expect } from "bun:test";
import * as fs from "fs";

describe("claim flow module", () => {
  test("is removed with backend scheduling", () => {
    expect(fs.existsSync("convex/scheduling/claim_flow.ts")).toBe(false);
  });
});
