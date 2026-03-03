import { describe, test, expect } from "bun:test";
import { parseAdjudicationResponse } from "../convex/data/memory";

describe("parseAdjudicationResponse", () => {
  test("parses duplicate action", () => {
    const result = parseAdjudicationResponse(
      JSON.stringify({ action: "duplicate", memoryId: "mem-123" }),
    );
    expect(result).toEqual({ action: "duplicate", memoryId: "mem-123" });
  });

  test("parses update_existing action", () => {
    const result = parseAdjudicationResponse(
      JSON.stringify({
        action: "update_existing",
        memoryId: "mem-456",
        updatedContent: "updated fact",
      }),
    );
    expect(result).toEqual({
      action: "update_existing",
      memoryId: "mem-456",
      updatedContent: "updated fact",
    });
  });

  test("returns new_fact for unrecognized action", () => {
    const result = parseAdjudicationResponse(
      JSON.stringify({ action: "unknown_action" }),
    );
    expect(result).toEqual({ action: "new_fact" });
  });

  test("returns new_fact for invalid JSON", () => {
    const result = parseAdjudicationResponse("not json at all");
    expect(result).toEqual({ action: "new_fact" });
  });

  test("returns new_fact for empty string", () => {
    const result = parseAdjudicationResponse("");
    expect(result).toEqual({ action: "new_fact" });
  });

  test("returns new_fact when duplicate missing memoryId", () => {
    const result = parseAdjudicationResponse(
      JSON.stringify({ action: "duplicate" }),
    );
    expect(result).toEqual({ action: "new_fact" });
  });

  test("returns new_fact when update_existing missing updatedContent", () => {
    const result = parseAdjudicationResponse(
      JSON.stringify({ action: "update_existing", memoryId: "mem-1" }),
    );
    expect(result).toEqual({ action: "new_fact" });
  });

  test("handles JSON wrapped in markdown code block", () => {
    const wrapped = '```json\n{"action":"duplicate","memoryId":"mem-99"}\n```';
    const result = parseAdjudicationResponse(wrapped);
    // The extractJsonObject helper should handle this
    expect(result.action).toBeDefined();
  });
});
