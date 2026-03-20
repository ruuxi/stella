import { describe, expect, test } from "bun:test";
import { parseWelcomeSuggestionsFromModelText } from "../convex/lib/welcome_suggestions_parse";
import { extractJsonBlock } from "../convex/lib/json";

describe("parseWelcomeSuggestionsFromModelText", () => {
  const item = {
    category: "app",
    title: "T",
    description: "D",
    prompt: "P",
  };

  test("parses raw JSON array", () => {
    expect(parseWelcomeSuggestionsFromModelText(JSON.stringify([item]))).toEqual(
      [item],
    );
  });

  test("strips ```json fence", () => {
    const text = '```json\n[\n  {"category":"skill","title":"S","description":"d","prompt":"p"}\n]\n```';
    expect(parseWelcomeSuggestionsFromModelText(text)).toHaveLength(1);
    expect(parseWelcomeSuggestionsFromModelText(text)[0].title).toBe("S");
  });

  test("handles preamble before fence", () => {
    const text = `Here are ideas:\n\`\`\`json\n${JSON.stringify([item])}\n\`\`\``;
    expect(parseWelcomeSuggestionsFromModelText(text)).toEqual([item]);
  });

  test("returns [] on invalid JSON inside fence", () => {
    expect(parseWelcomeSuggestionsFromModelText("```json\nnot json\n```")).toEqual(
      [],
    );
  });
});

describe("extractJsonBlock", () => {
  test("returns bracket slice when no fence", () => {
    expect(extractJsonBlock('prefix [{"x":1}]')).toBe('[{"x":1}]');
  });
});
