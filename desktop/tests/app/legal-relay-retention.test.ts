import { describe, expect, it } from "vitest";

import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
} from "../../src/global/legal/legal-text.js";

describe("relay recovery privacy disclosure", () => {
  it("prominently discloses transient response content and physical deletion limits", () => {
    for (const document of [TERMS_OF_SERVICE, PRIVACY_POLICY]) {
      expect(document).toContain("tool-call arguments");
      expect(document).toContain("1 MiB");
      expect(document).toContain("two minutes");
      expect(document).toContain("fifteen minutes");
      expect(document).toContain("not end-to-end encrypted");
      expect(document).toContain("absolute physical-deletion");
    }
    expect(PRIVACY_POLICY).toContain("US East (Northern Virginia)");
    expect(PRIVACY_POLICY).toContain("provider-managed backups");
  });
});
