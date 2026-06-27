import { describe, expect, it } from "bun:test";

import {
  isRestrictedAudienceAllowedStellaModelId,
  isRestrictedModelOverrideAudience,
} from "../../../src/global/billing/audience";

describe("billing audience model restrictions", () => {
  it("marks the restricted override audiences", () => {
    expect(isRestrictedModelOverrideAudience("anonymous")).toBe(true);
    expect(isRestrictedModelOverrideAudience("free")).toBe(true);
    expect(isRestrictedModelOverrideAudience("go")).toBe(true);
    expect(isRestrictedModelOverrideAudience("go_fallback")).toBe(true);
    expect(isRestrictedModelOverrideAudience("pro")).toBe(false);
    expect(isRestrictedModelOverrideAudience("plus")).toBe(false);
    expect(isRestrictedModelOverrideAudience("ultra")).toBe(false);
  });

  it("lets restricted audiences pick only the Standard and Light modes", () => {
    expect(isRestrictedAudienceAllowedStellaModelId("stella/standard")).toBe(
      true,
    );
    expect(isRestrictedAudienceAllowedStellaModelId("stella/light")).toBe(true);
    expect(isRestrictedAudienceAllowedStellaModelId("stella/designer")).toBe(
      false,
    );
    expect(
      isRestrictedAudienceAllowedStellaModelId("stella/openai/gpt-5.5"),
    ).toBe(false);
  });
});
