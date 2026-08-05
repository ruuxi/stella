import { describe, expect, it } from "vitest";

import {
  extractRelevantWebText,
  MAX_FETCH_BODY_CHARS,
  MAX_PROMPT_FETCH_BODY_CHARS,
} from "../../../../../runtime/kernel/tools/local-tool-overrides.js";

describe("local web fetch model-facing bounds", () => {
  it("keeps prompt-relevant excerpts from deep in a long page", () => {
    const page = [
      "Navigation and unrelated introduction",
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `Unrelated changelog entry ${index} with filler ${"x".repeat(80)}`,
      ),
      "Express 5.1.0",
      "This release requires Node.js 18 or higher.",
      "The stable release includes the new path syntax.",
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `Older unrelated entry ${index} with filler ${"y".repeat(80)}`,
      ),
    ].join("\n");

    const extracted = extractRelevantWebText(
      page,
      "Express 5.1.0 stable release and Node.js requirement",
    );

    expect(extracted.length).toBeLessThanOrEqual(MAX_PROMPT_FETCH_BODY_CHARS);
    expect(extracted).toContain("Express 5.1.0");
    expect(extracted).toContain("Node.js 18 or higher");
    expect(extracted).not.toContain("Unrelated changelog entry 100");
  });

  it("bounds unprompted pages while retaining both ends", () => {
    const page = `PAGE-START\n${"z".repeat(MAX_FETCH_BODY_CHARS * 2)}\nPAGE-END`;

    const extracted = extractRelevantWebText(page);

    expect(extracted.length).toBeLessThanOrEqual(MAX_FETCH_BODY_CHARS);
    expect(extracted).toMatch(/^PAGE-START/);
    expect(extracted).toMatch(/PAGE-END$/);
    expect(extracted).toContain("[Content truncated]");
  });
});
