import { describe, expect, test } from "bun:test";
import { parseDashboardPlanPages } from "../convex/lib/dashboard_plan_llm";

describe("parseDashboardPlanPages", () => {
  test("parses raw JSON array", () => {
    const text = `[{"pageId":"alpha","title":"Alpha","topic":"About alpha","focus":"Build alpha view with feeds.","personalOrEntertainment":false,"dataSources":["HN API"]},{"pageId":"beta","title":"Beta","topic":"Beta topic","focus":"Beta focus lines.","personalOrEntertainment":false,"dataSources":["RSS"]},{"pageId":"gamma","title":"Gamma","topic":"Gamma topic","focus":"Gamma focus.","personalOrEntertainment":true,"dataSources":[]}]`;
    const pages = parseDashboardPlanPages(text);
    expect(pages).toHaveLength(3);
    expect(pages[0].pageId).toBe("alpha");
    expect(pages[1].title).toBe("Beta");
    expect(pages[2].dataSources).toHaveLength(0);
    expect(pages.some((p) => p.personalOrEntertainment)).toBe(true);
  });

  test("strips markdown fence", () => {
    const text =
      '```json\n[{"pageId":"a","title":"A","topic":"t","focus":"f","personalOrEntertainment":true,"dataSources":["x"]},{"pageId":"b","title":"B","topic":"t","focus":"f","personalOrEntertainment":false,"dataSources":["y"]},{"pageId":"c","title":"C","topic":"t","focus":"f","personalOrEntertainment":false,"dataSources":["z"]}]\n```';
    const pages = parseDashboardPlanPages(text);
    expect(pages).toHaveLength(3);
  });

  test("rejects plan with no personalOrEntertainment page", () => {
    const text = `[{"pageId":"a","title":"A","topic":"t","focus":"f","personalOrEntertainment":false,"dataSources":[]},{"pageId":"b","title":"B","topic":"t","focus":"f","personalOrEntertainment":false,"dataSources":[]},{"pageId":"c","title":"C","topic":"t","focus":"f","personalOrEntertainment":false,"dataSources":[]}]`;
    expect(() => parseDashboardPlanPages(text)).toThrow(
      /personalOrEntertainment/,
    );
  });
});
