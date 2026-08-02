import { describe, expect, it } from "vitest";

import { isApprovedComposioOAuthUrl } from "../../../electron/services/connector-oauth-service.js";

describe("Composio OAuth URL policy", () => {
  it("allows only HTTPS URLs on approved Composio hosts", () => {
    expect(
      isApprovedComposioOAuthUrl("https://app.composio.dev/link/abc"),
    ).toBe(true);
    expect(
      isApprovedComposioOAuthUrl("https://connect.composio.dev/oauth/abc"),
    ).toBe(true);
    expect(
      isApprovedComposioOAuthUrl("https://backend.composio.dev/oauth/abc"),
    ).toBe(true);
  });

  it("rejects insecure, lookalike, and subdomain URLs", () => {
    expect(isApprovedComposioOAuthUrl("http://app.composio.dev/link/abc")).toBe(
      false,
    );
    expect(
      isApprovedComposioOAuthUrl("https://app.composio.dev.evil.test/link"),
    ).toBe(false);
    expect(
      isApprovedComposioOAuthUrl("https://evil.app.composio.dev/link"),
    ).toBe(false);
    expect(isApprovedComposioOAuthUrl("javascript:alert(1)")).toBe(false);
  });
});
