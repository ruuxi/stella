import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/events.ts", "utf-8");

describe("events module structure", () => {
  test("uses orderEventsChronologically for sorting", () => {
    // Verify the deduplicated sort helper is used
    expect(source).toContain("orderEventsChronologically");
  });

  test("exports subscription queries", () => {
    expect(source).toContain("subscribeRemoteTurnRequestsForDevice");
    expect(source).toContain("subscribeDashboardGenRequestsForDevice");
  });

  test("exports event management functions", () => {
    expect(source).toContain("export const appendEvent =");
    expect(source).toContain("export const appendInternalEvent =");
    expect(source).toContain("export const saveAssistantMessage =");
  });

  test("exports query functions", () => {
    expect(source).toContain("export const listEvents =");
    expect(source).toContain("export const listRecentMessages =");
    expect(source).toContain("export const countByConversation =");
  });

  test("uses deviceSubscriptionHandler factory", () => {
    expect(source).toContain("deviceSubscriptionHandler");
  });

  test("has args validators on exported functions", () => {
    // Some functions use args: { ... } and others use deviceSubscriptionArgs
    const argsCount = (source.match(/\bargs[\s:]/g) || []).length;
    expect(argsCount).toBeGreaterThan(15);
  });
});
