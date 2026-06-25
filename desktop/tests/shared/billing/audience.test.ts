import { describe, expect, it } from "bun:test";

import { isRestrictedModelOverrideAudience } from "../../../src/global/billing/audience";

describe("billing audience model restrictions", () => {
  it("pins restricted audiences to the backend default (no model override)", () => {
    expect(isRestrictedModelOverrideAudience("anonymous")).toBe(true);
    expect(isRestrictedModelOverrideAudience("free")).toBe(true);
    expect(isRestrictedModelOverrideAudience("go")).toBe(true);
    expect(isRestrictedModelOverrideAudience("go_fallback")).toBe(true);
    expect(isRestrictedModelOverrideAudience("pro")).toBe(false);
    expect(isRestrictedModelOverrideAudience("plus")).toBe(false);
    expect(isRestrictedModelOverrideAudience("ultra")).toBe(false);
  });
});
