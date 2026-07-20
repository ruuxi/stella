import { describe, expect, it } from "vitest";

import { IMAGE_PROVIDER_OPTIONS } from "../../../src/global/settings/AgentModelPicker";

describe("image provider privacy copy", () => {
  it("discloses direct BYOK reference transmission and the ambiguous boundary", () => {
    for (const provider of IMAGE_PROVIDER_OPTIONS.filter(
      ({ key }) => key !== "stella",
    )) {
      expect(provider.description).toContain("directly from this device");
      expect(provider.description).toContain("reported as unknown");
      expect(provider.description).toContain("never blindly retried");
    }
    expect(
      IMAGE_PROVIDER_OPTIONS.find(({ key }) => key === "stella")?.description,
    ).toContain("per-generation upload consent");
  });
});
