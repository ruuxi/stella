import { describe, expect, it, vi } from "vitest";
import { runMobileHello } from "../../electron/ipc/mobile-hello-handlers.js";

const makeOptions = () => {
  const syncMessages = vi.fn(() => ({
    messages: [{ localMessageId: "message-1" }],
    cursor: "v1:2:message-1",
  }));
  return {
    syncMessages,
    options: {
      localChatHistoryService: {
        getOrCreateDefaultConversationId: () => "conversation-1",
        syncMessages,
      } as any,
      getActiveConversationId: () => "conversation-1",
      getUiStateSnapshot: () => ({}),
    },
  };
};

describe("mobile:hello", () => {
  it("folds the caller's real first sync into the handshake", async () => {
    const { options, syncMessages } = makeOptions();
    const result = await runMobileHello(options, {
      expectedConversationId: "conversation-1",
      sinceCursor: "v1:1:message-0",
      maxMessages: 100,
    });
    expect(syncMessages).toHaveBeenCalledTimes(1);
    expect(syncMessages).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      sinceCursor: "v1:1:message-0",
      maxMessages: 100,
      includeDeveloperArtifacts: false,
    });
    expect(result.messages).toHaveLength(1);
  });

  it("negotiates capabilities without reading the transcript", async () => {
    const { options, syncMessages } = makeOptions();
    const result = await runMobileHello(options, {
      negotiateOnly: true,
      maxMessages: 1,
    });
    expect(syncMessages).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
    expect(result.features).toContain("envelope-deflate");
  });
});
