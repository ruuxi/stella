import { describe, expect, it } from "vitest";
import type { LocalChatUpdatedPayload } from "../../../../runtime/contracts/local-chat.js";
import { resolveConnectorFollowupAction } from "../../../../runtime/host/connector-followup.js";

const payload = (
  type: string,
  eventPayload: Record<string, unknown>,
): LocalChatUpdatedPayload => ({
  conversationId: "conversation-1",
  event: {
    _id: "event-1",
    timestamp: 1,
    type,
    payload: eventPayload,
  },
});

describe("connector follow-up routing", () => {
  it("keeps connector-sourced user and assistant messages off the follow-up sink", () => {
    expect(
      resolveConnectorFollowupAction(
        payload("user_message", { text: "from phone", source: "connector" }),
      ),
    ).toEqual({ type: "ignore" });

    expect(
      resolveConnectorFollowupAction(
        payload("assistant_message", {
          text: "initial reply",
          source: "connector",
        }),
      ),
    ).toEqual({ type: "ignore" });
  });

  it("clears the connector target when the desktop user takes over", () => {
    expect(
      resolveConnectorFollowupAction(
        payload("user_message", { text: "desktop reply" }),
      ),
    ).toEqual({ type: "clear-target" });
  });

  it("sends normal assistant replies to the connector follow-up sink", () => {
    expect(
      resolveConnectorFollowupAction(
        payload("assistant_message", { text: " done " }),
      ),
    ).toEqual({ type: "send", text: "done" });
  });

  it("ignores raw agent completion results", () => {
    expect(
      resolveConnectorFollowupAction(
        payload("agent-completed", {
          agentId: "task-8",
          result: " finished ",
        }),
      ),
    ).toEqual({ type: "ignore" });
  });
});
