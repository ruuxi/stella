import { describe, expect, it } from "vitest";
import {
  buildManagedMediaDocsPrompt,
  buildManagedMediaDocsUrl,
} from "../../../packages/runtime-kernel/runner/shared.js";

describe("runner shared helpers", () => {
  it("builds the managed media docs URL from a Convex cloud URL", () => {
    expect(
      buildManagedMediaDocsUrl("https://stellar-123.convex.cloud"),
    ).toBe("https://stellar-123.convex.site/api/media/v1/docs");
  });

  it("builds a self-mod friendly prompt snippet for the live media docs", () => {
    const prompt = buildManagedMediaDocsPrompt(
      "https://stellar-123.convex.cloud",
    );

    expect(prompt).toContain("Managed backend media SDK:");
    expect(prompt).toContain(
      "https://stellar-123.convex.site/api/media/v1/docs",
    );
    expect(prompt).toContain("curl -L");
  });
});
