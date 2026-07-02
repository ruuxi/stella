import { describe, expect, it } from "vitest";

import { isSocialInviteDeepLink } from "../../electron/services/social-deep-links";

// Classification behind the auth-service protocol funnel: URLs accepted
// here are routed to the renderer's confirmation layer; everything else
// stays on the (strict) auth-callback trust path and is dropped if it
// doesn't match that either.
describe("isSocialInviteDeepLink", () => {
  it("accepts community join links", () => {
    expect(isSocialInviteDeepLink("stella://join/ABCD2345", "stella")).toBe(
      true,
    );
    expect(isSocialInviteDeepLink("stella://join/abcd-efgh", "stella")).toBe(
      true,
    );
  });

  it("rejects join codes the renderer's parser would drop", () => {
    // The classifier delegates to the shared grammar: a URL accepted here
    // but dropped by `parseSocialInviteLink` would vanish silently after
    // being diverted off the auth path.
    expect(isSocialInviteDeepLink("stella://join/abc", "stella")).toBe(false);
    expect(isSocialInviteDeepLink("stella://join/my_code99", "stella")).toBe(
      false,
    );
    expect(
      isSocialInviteDeepLink("stella://join/waytoolongcode", "stella"),
    ).toBe(false);
  });

  it("accepts add-friend links", () => {
    expect(
      isSocialInviteDeepLink("stella://add-friend/swift-otter-42", "stella"),
    ).toBe(true);
  });

  it("accepts store package links", () => {
    expect(
      isSocialInviteDeepLink("stella://store/handle/my-package", "stella"),
    ).toBe(true);
    expect(
      isSocialInviteDeepLink("stella://store/Handle_1/pkg.name-2", "stella"),
    ).toBe(true);
  });

  it("rejects store links with the wrong number of segments", () => {
    expect(isSocialInviteDeepLink("stella://store/handle", "stella")).toBe(
      false,
    );
    expect(
      isSocialInviteDeepLink("stella://store/handle/pkg/extra", "stella"),
    ).toBe(false);
    expect(isSocialInviteDeepLink("stella://store/", "stella")).toBe(false);
  });

  it("rejects invalid identifier characters", () => {
    expect(
      isSocialInviteDeepLink("stella://store/bad$handle/pkg", "stella"),
    ).toBe(false);
    expect(
      isSocialInviteDeepLink("stella://store/handle/bad$pkg", "stella"),
    ).toBe(false);
    expect(
      isSocialInviteDeepLink("stella://add-friend/bad user", "stella"),
    ).toBe(false);
  });

  it("never claims auth callbacks or unknown hosts", () => {
    expect(
      isSocialInviteDeepLink("stella://auth/callback?ott=abc", "stella"),
    ).toBe(false);
    expect(
      isSocialInviteDeepLink("stella://oauth/callback/x?state=1", "stella"),
    ).toBe(false);
    expect(isSocialInviteDeepLink("stella://settings/anything", "stella")).toBe(
      false,
    );
  });

  it("only matches the configured protocol", () => {
    expect(
      isSocialInviteDeepLink("https://stella.sh/join/ABCDEFGH", "stella"),
    ).toBe(false);
    expect(
      isSocialInviteDeepLink("stella://join/ABCD2345", "stella-dev"),
    ).toBe(false);
    expect(
      isSocialInviteDeepLink("stella-dev://join/ABCD2345", "stella-dev"),
    ).toBe(true);
  });

  it("tolerates garbage input", () => {
    expect(isSocialInviteDeepLink("", "stella")).toBe(false);
    expect(isSocialInviteDeepLink("not a url", "stella")).toBe(false);
  });
});
