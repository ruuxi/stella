import { describe, test, expect } from "bun:test";
import { DISCOVERY_FACT_EXTRACTION_PROMPT } from "../convex/prompts/discovery_facts";

describe("DISCOVERY_FACT_EXTRACTION_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof DISCOVERY_FACT_EXTRACTION_PROMPT).toBe("string");
    expect(DISCOVERY_FACT_EXTRACTION_PROMPT.length).toBeGreaterThan(100);
  });

  test("requests JSON array output", () => {
    expect(DISCOVERY_FACT_EXTRACTION_PROMPT).toContain("JSON array");
  });

  test("defines fact extraction rules", () => {
    expect(DISCOVERY_FACT_EXTRACTION_PROMPT).toContain("Rules");
    expect(DISCOVERY_FACT_EXTRACTION_PROMPT).toContain("self-contained");
  });

  test("specifies fact limit", () => {
    expect(DISCOVERY_FACT_EXTRACTION_PROMPT).toContain("25-35");
  });

  test("includes good and bad examples", () => {
    expect(DISCOVERY_FACT_EXTRACTION_PROMPT).toContain("GOOD");
    expect(DISCOVERY_FACT_EXTRACTION_PROMPT).toContain("BAD");
  });
});
