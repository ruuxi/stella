import { describe, expect, test } from "bun:test";
import { parseAdjudicationResponse } from "../convex/data/memory";

describe("memory adjudication parser", () => {
  test("parses duplicate action successfully", () => {
    const response = '{"action":"duplicate","memoryId":"test_id_123"}';
    const parsed = parseAdjudicationResponse(response);
    expect(parsed).toEqual({ action: "duplicate", memoryId: "test_id_123" });
  });

  test("parses update_existing action successfully", () => {
    const response = '{"action":"update_existing","memoryId":"test_id_456","updatedContent":"User likes red now"}';
    const parsed = parseAdjudicationResponse(response);
    expect(parsed).toEqual({
      action: "update_existing",
      memoryId: "test_id_456",
      updatedContent: "User likes red now"
    });
  });

  test("parses new_fact action successfully", () => {
    const response = '{"action":"new_fact"}';
    const parsed = parseAdjudicationResponse(response);
    expect(parsed).toEqual({ action: "new_fact" });
  });

  test("handles json wrapped in markdown block", () => {
    const response = `\`\`\`json
{"action":"duplicate","memoryId":"111"}
\`\`\``;
    const parsed = parseAdjudicationResponse(response);
    expect(parsed).toEqual({ action: "duplicate", memoryId: "111" });
  });

  test("falls back to new_fact on missing memoryId for duplicate", () => {
    const response = '{"action":"duplicate"}';
    const parsed = parseAdjudicationResponse(response);
    expect(parsed).toEqual({ action: "new_fact" });
  });

  test("falls back to new_fact on missing memoryId or content for update_existing", () => {
    const response = '{"action":"update_existing","memoryId":"123"}'; // Missing updatedContent
    const parsed = parseAdjudicationResponse(response);
    expect(parsed).toEqual({ action: "new_fact" });
  });

  test("falls back to new_fact on invalid json", () => {
    const response = 'I think this is a new fact';
    const parsed = parseAdjudicationResponse(response);
    expect(parsed).toEqual({ action: "new_fact" });
  });
});
