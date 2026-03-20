import { describe, test, expect } from "bun:test";
import {
  buildPersonalizedDashboardPageUserMessage,
} from "../convex/prompts/personalized_dashboard";
import type { PersonalizedDashboardPageAssignment } from "../convex/prompts/personalized_dashboard";

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
      userProfile: "User is a developer",
      assignment,
      promptTemplate: "Page {{pageId}} {{title}} {{panelName}} {{topic}} {{focus}}",
    });
    expect(result).toContain("page-1");
    expect(result).toContain("Dev Dashboard");
    expect(result).toContain("dev_dashboard");
  });

  test("includes user profile", () => {
    const result = buildPersonalizedDashboardPageUserMessage({
      userProfile: "Uses TypeScript daily",
      assignment,
      promptTemplate: "Profile {{userProfile}}",
    });
    expect(result).toContain("Uses TypeScript daily");
  });

  test("includes data sources", () => {
    const result = buildPersonalizedDashboardPageUserMessage({
      userProfile: "profile",
      assignment,
      promptTemplate: "Sources\n{{suggestedSources}}",
    });
    expect(result).toContain("https://api.github.com");
  });

  test("handles empty data sources", () => {
    const emptyAssignment = { ...assignment, dataSources: [] };
    const result = buildPersonalizedDashboardPageUserMessage({
      userProfile: "profile",
      assignment: emptyAssignment,
      promptTemplate: "Sources\n{{suggestedSources}}",
    });
    expect(result).toContain("Find relevant public");
  });

  test("fills pageFocusGuidance when personal and no data sources", () => {
    const result = buildPersonalizedDashboardPageUserMessage({
      userProfile: "profile",
      assignment: {
        ...assignment,
        dataSources: [],
        personalOrEntertainment: true,
      },
      promptTemplate: "X{{pageFocusGuidance}}Y",
    });
    expect(result).toContain("personal/entertainment-first");
    expect(result).toContain("No specific feeds were planned");
  });
});
