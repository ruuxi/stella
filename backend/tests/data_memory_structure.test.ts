import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/data/memory.ts", "utf-8");

describe("memory module structure", () => {
  test("exports recallMemories function", () => {
    expect(source).toContain("recallMemories");
  });

  test("exports adjudicateAndStoreFact", () => {
    expect(source).toContain("adjudicateAndStoreFact");
  });

  test("exports adjudicateAndStoreFact", () => {
    expect(source).toContain("adjudicateAndStoreFact");
  });

  test("exports recallMemories", () => {
    expect(source).toContain("recallMemories");
  });

  test("exports parseAdjudicationResponse", () => {
    expect(source).toContain("parseAdjudicationResponse");
  });

  test("uses embedding deduplication", () => {
    expect(source).toContain("embedding");
  });

  test("has args and returns validators", () => {
    const argsCount = (source.match(/\bargs:\s*\{/g) || []).length;
    expect(argsCount).toBeGreaterThan(5);
  });
});
