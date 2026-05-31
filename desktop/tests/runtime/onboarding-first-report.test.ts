import { describe, expect, it } from "vitest";
import { buildOnboardingFirstReport } from "@/global/onboarding/services/first-report";

describe("onboarding first report", () => {
  it("wraps backend-generated welcome HTML without local fallback content", () => {
    const report = buildOnboardingFirstReport(
      '<!doctype html><html><head><title>Welcome</title></head><body><article data-stella-compose="Make a launch checklist">Make a launch checklist</article></body></html>',
    );

    expect(report.slug).toBe("welcome");
    expect(report.title).toBe("Welcome");
    expect(report.html).toContain("Make a launch checklist");
    expect(report.html).not.toContain("Shell History");
    expect(report.html).not.toContain(">bun<");
    expect(report.html).not.toContain("Help me act on this welcome idea:");
  });
});
