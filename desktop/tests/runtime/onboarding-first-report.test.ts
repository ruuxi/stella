import { describe, expect, it } from "vitest";
import { buildOnboardingFirstReport } from "@/global/onboarding/services/first-report";

describe("onboarding first report", () => {
  it("writes the welcome canvas with Ask Stella compose prompts", () => {
    const report = buildOnboardingFirstReport({
      coreMemory: "- Uses Stella for recurring launch checklists",
      welcomeMessage: "Welcome back.",
      categoryAnalyses: {
        dev_environment: "- Works in the Stella desktop repo",
      },
    });

    expect(report.slug).toBe("welcome");
    expect(report.title).toBe("Welcome");
    expect(report.html).toContain("<title>Welcome</title>");
    expect(report.html).not.toContain("report-welcome");
    expect(report.html).toContain("data-stella-compose=");
    expect(report.html).toContain("Help me act on this welcome idea:");
    expect(report.html).toContain("Hover an idea and choose Ask Stella");
  });
});
