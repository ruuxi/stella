import { describe, expect, it } from "vitest";
import { computeShowHomeContent } from "../../src/app/chat/hooks/use-idle-home-visibility";

describe("computeShowHomeContent", () => {
  it("keeps home visible when back was forced during active streaming", () => {
    expect(
      computeShowHomeContent({
        hasMessages: true,
        isStreaming: true,
        isIdle: true,
        isForcedHome: true,
      }),
    ).toBe(true);
  });

  it("shows home for idle chats once streaming has ended", () => {
    expect(
      computeShowHomeContent({
        hasMessages: true,
        isStreaming: false,
        isIdle: true,
        isForcedHome: false,
      }),
    ).toBe(true);
  });

  it("keeps active chats on messages when home was not explicitly requested", () => {
    expect(
      computeShowHomeContent({
        hasMessages: true,
        isStreaming: true,
        isIdle: false,
        isForcedHome: false,
      }),
    ).toBe(false);
  });
});
