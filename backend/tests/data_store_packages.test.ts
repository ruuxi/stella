import { describe, test, expect } from "bun:test";
import * as fs from "fs";

// store_packages.ts has non-exported helpers; test the module structure via source analysis
const source = fs.readFileSync("convex/data/store_packages.ts", "utf-8");

describe("store_packages module structure", () => {
  test("exports list query", () => {
    expect(source).toContain("export const list = query(");
  });

  test("exports search query", () => {
    expect(source).toContain("export const search =");
  });

  test("exports getByPackageId", () => {
    expect(source).toContain("export const getByPackageId =");
  });

  test("uses requireUserId for auth", () => {
    expect(source).toContain("requireUserId");
  });

  test("defines packageTypeValidator with expected types", () => {
    expect(source).toContain('v.literal("skill")');
    expect(source).toContain('v.literal("canvas")');
    expect(source).toContain('v.literal("theme")');
    expect(source).toContain('v.literal("mod")');
  });

  test("has buildSearchText helper", () => {
    expect(source).toContain("buildSearchText");
  });

  test("uses ConvexError for structured errors", () => {
    expect(source).toContain("ConvexError");
  });

  test("includes args and returns validators", () => {
    const argsCount = (source.match(/\bargs:\s*\{/g) || []).length;
    const returnsCount = (source.match(/\breturns:\s*v\./g) || []).length;
    expect(argsCount).toBeGreaterThan(3);
    expect(returnsCount).toBeGreaterThan(3);
  });
});
