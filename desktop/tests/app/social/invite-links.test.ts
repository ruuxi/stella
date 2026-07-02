import { describe, expect, it } from "vitest";
import { parseSocialInviteLink } from "@/app/social/invite-links";

describe("parseSocialInviteLink", () => {
  it("parses community join deep links and normalizes the code", () => {
    expect(parseSocialInviteLink("stella://join/abcd-efgh")).toEqual({
      kind: "join-community",
      inviteCode: "ABCDEFGH",
    });
    expect(parseSocialInviteLink("stella://join/ABCD2345")).toEqual({
      kind: "join-community",
      inviteCode: "ABCD2345",
    });
  });

  it("parses community join web links", () => {
    expect(
      parseSocialInviteLink("https://stella.sh/join/ABCD-EFGH"),
    ).toEqual({
      kind: "join-community",
      inviteCode: "ABCDEFGH",
    });
  });

  it("parses add-friend links in both forms and lowercases the username", () => {
    expect(parseSocialInviteLink("stella://add-friend/Swift-Otter-42")).toEqual(
      {
        kind: "add-friend",
        username: "swift-otter-42",
      },
    );
    expect(
      parseSocialInviteLink("https://stella.sh/add-friend/swift-otter-42"),
    ).toEqual({
      kind: "add-friend",
      username: "swift-otter-42",
    });
  });

  it("parses store deep links into a view request", () => {
    expect(
      parseSocialInviteLink("stella://store/Swift-Otter/My.Package_1"),
    ).toEqual({
      kind: "view-store-package",
      authorUsername: "swift-otter",
      packageId: "my.package_1",
    });
  });

  it("does NOT accept a web form for store links (deliberately unbuilt)", () => {
    expect(
      parseSocialInviteLink("https://stella.sh/store/handle/package"),
    ).toBeNull();
  });

  it("rejects malformed store links", () => {
    expect(parseSocialInviteLink("stella://store/onlyhandle")).toBeNull();
    expect(parseSocialInviteLink("stella://store/a/b/c")).toBeNull();
    expect(parseSocialInviteLink("stella://store//pkg")).toBeNull();
    expect(parseSocialInviteLink("stella://store/bad$handle/pkg")).toBeNull();
    expect(parseSocialInviteLink("stella://store/handle/bad$pkg")).toBeNull();
  });

  it("rejects unrelated hosts, schemes, and non-anchored input", () => {
    expect(parseSocialInviteLink("stella://auth/callback?ott=x")).toBeNull();
    expect(parseSocialInviteLink("https://example.com/join/ABCDEFGH")).toBeNull();
    expect(parseSocialInviteLink("ftp://stella.sh/join/ABCDEFGH")).toBeNull();
    expect(
      parseSocialInviteLink("check this stella://join/ABCDEFGH out"),
    ).toBeNull();
    expect(parseSocialInviteLink("")).toBeNull();
  });

  it("rejects bad identifiers", () => {
    expect(parseSocialInviteLink("stella://join/short")).toBeNull();
    expect(parseSocialInviteLink("stella://join/way-too-long-code")).toBeNull();
    expect(parseSocialInviteLink("stella://add-friend/")).toBeNull();
    expect(parseSocialInviteLink("stella://add-friend/a/b")).toBeNull();
  });
});
