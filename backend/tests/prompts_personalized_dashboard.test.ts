import { describe, test, expect } from "bun:test";
import {
  PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
  buildPersonalizedDashboardPageUserMessage,
} from "../convex/prompts/personalized_dashboard";
import type { PersonalizedDashboardPageAssignment } from "../convex/prompts/personalized_dashboard";

describe("PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT).toBe("string");
    expect(PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT.length).toBeGreaterThan(200);
  });

  test("includes design guidelines", () => {
    expect(PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT).toContain("VISUAL DESIGN");
    expect(PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT).toContain("transparent");
  });

  test("includes data sourcing rules", () => {
    expect(PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT).toContain("DATA SOURCING");
    expect(PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT).toContain("public");
  });

  test("mentions stella:send-message event", () => {
    expect(PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT).toContain("stella:send-message");
  });
});

describe("buildPersonalizedDashboardPageUserMessage", () => {
  const assignment: PersonalizedDashboardPageAssignment = {
    pageId: "page-1",
    title: "Dev Dashboard",
    topic: "development",
    focus: "Recent activity",
    panelName: "dev_dashboard",
    dataSources: ["https://api.github.com"],
  };

  test("includes assignment details", () => {
    const result = buildPersonalizedDashboardPageUserMessage({
      coreMemory: "User is a developer",
      assignment,
    });
    expect(result).toContain("page-1");
    expect(result).toContain("Dev Dashboard");
    expect(result).toContain("dev_dashboard");
  });

  test("includes core memory", () => {
    const result = buildPersonalizedDashboardPageUserMessage({
      coreMemory: "Uses TypeScript daily",
      assignment,
    });
    expect(result).toContain("Uses TypeScript daily");
  });

  test("includes data sources", () => {
    const result = buildPersonalizedDashboardPageUserMessage({
      coreMemory: "profile",
      assignment,
    });
    expect(result).toContain("https://api.github.com");
  });

  test("handles empty data sources", () => {
    const emptyAssignment = { ...assignment, dataSources: [] };
    const result = buildPersonalizedDashboardPageUserMessage({
      coreMemory: "profile",
      assignment: emptyAssignment,
    });
    expect(result).toContain("Find relevant public");
  });
});
