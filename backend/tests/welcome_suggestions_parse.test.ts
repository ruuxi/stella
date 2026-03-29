import { describe, expect, test } from "bun:test";
import { parseHomeSuggestionsFromModelText } from "../convex/lib/welcome_suggestions_parse";
import { extractJsonBlock } from "../convex/lib/json";

describe("parseHomeSuggestionsFromModelText", () => {
  const item = {
    category: "stella",
    label: "T",
    prompt: "P",
  } as const;

  test("parses raw JSON array", () => {
    expect(parseHomeSuggestionsFromModelText(JSON.stringify([item]))).toEqual([
      item,
    ]);
  });

  test("strips ```json fence", () => {
    const text =
      '```json\n[\n  {"category":"task","label":"S","prompt":"p"}\n]\n```';
    expect(parseHomeSuggestionsFromModelText(text)).toHaveLength(1);
    expect(parseHomeSuggestionsFromModelText(text)[0].label).toBe("S");
  });

  test("handles preamble before fence", () => {
    const text = `Here are ideas:\n\`\`\`json\n${JSON.stringify([item])}\n\`\`\``;
    expect(parseHomeSuggestionsFromModelText(text)).toEqual([item]);
  });

  test("returns [] on invalid JSON inside fence", () => {
    expect(parseHomeSuggestionsFromModelText("```json\nnot json\n```")).toEqual(
      [],
    );
  });
});

describe("extractJsonBlock", () => {
  test("returns bracket slice when no fence", () => {
    expect(extractJsonBlock('prefix [{"x":1}]')).toBe('[{"x":1}]');
  });
});
