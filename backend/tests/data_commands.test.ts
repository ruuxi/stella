import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/data/commands.ts", "utf-8");

describe("commands module structure", () => {
  test("exports listCatalog", () => {
    expect(source).toContain("export const listCatalog =");
  });

  test("exports getByCommandId", () => {
    expect(source).toContain("export const getByCommandId =");
  });

  test("uses internalQuery for both exports", () => {
    expect(source).toContain("internalQuery");
  });

  test("returns cataloged fields", () => {
    expect(source).toContain("commandId");
    expect(source).toContain("name");
    expect(source).toContain("description");
    expect(source).toContain("pluginName");
  });

  test("has args and returns validators", () => {
    const argsCount = (source.match(/\bargs:\s*\{/g) || []).length;
    const returnsCount = (source.match(/\breturns:\s*v\./g) || []).length;
    expect(argsCount).toBeGreaterThanOrEqual(2);
    expect(returnsCount).toBeGreaterThanOrEqual(1);
  });
});
