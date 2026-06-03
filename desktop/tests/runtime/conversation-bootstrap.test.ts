import { describe, expect, it } from "vitest";
import { getPersistedChatConversationId } from "../../src/bootstrap/conversation-bootstrap-location";

describe("conversation bootstrap", () => {
  it("preserves the conversation id from a persisted chat route", () => {
    expect(getPersistedChatConversationId("/chat?c=01KT55K6Y53N1MKX5T1VRKAC9J")).toBe(
      "01KT55K6Y53N1MKX5T1VRKAC9J",
    );
  });

  it("ignores chat routes without a conversation id", () => {
    expect(getPersistedChatConversationId("/chat")).toBeNull();
    expect(getPersistedChatConversationId("/chat?dialog=connect")).toBeNull();
  });

  it("ignores non-chat routes", () => {
    expect(getPersistedChatConversationId("/settings?c=wrong")).toBeNull();
    expect(getPersistedChatConversationId(null)).toBeNull();
  });
});
