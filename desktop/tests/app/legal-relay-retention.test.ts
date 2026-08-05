import { describe, expect, it } from "vitest";

import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
} from "../../src/global/legal/legal-text.js";

describe("managed inference privacy disclosure", () => {
  it("describes transit-only inference without claiming a recovery buffer", () => {
    for (const document of [TERMS_OF_SERVICE, PRIVACY_POLICY]) {
      expect(document).toContain("in transit");
      expect(document).not.toContain("recovery buffer");
      expect(document).not.toContain("1 MiB");
      expect(document).not.toContain("resume API");
    }
    expect(PRIVACY_POLICY).toContain("US East (Northern Virginia)");
    expect(PRIVACY_POLICY).toContain(
      "does not persist an in-progress response",
    );
  });
});
