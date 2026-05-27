import { describe, expect, it } from "bun:test";

import {
  isRestrictedAudienceAllowedStellaModelId,
  isRestrictedModelOverrideAudience,
} from "../../../src/shared/billing/audience";

describe("billing audience model restrictions", () => {
  it("keeps restricted Stella audiences pinned except for Standard and Light", () => {
    expect(isRestrictedModelOverrideAudience("anonymous")).toBe(true);
    expect(isRestrictedAudienceAllowedStellaModelId("stella/standard")).toBe(
      true,
    );
    expect(isRestrictedAudienceAllowedStellaModelId("stella/light")).toBe(true);
    expect(isRestrictedAudienceAllowedStellaModelId("stella/builder")).toBe(
      false,
    );
    expect(
      isRestrictedAudienceAllowedStellaModelId(
        "stella/openrouter/anthropic/claude-opus-4.7",
      ),
    ).toBe(false);
  });
});
