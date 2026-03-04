import { describe, expect, it } from "vitest";
import { isOrchestratorChatMessagePayload } from "./message-source";

describe("isOrchestratorChatMessagePayload", () => {
  it("allows legacy payloads with no source", () => {
    expect(isOrchestratorChatMessagePayload({ text: "hi" })).toBe(true);
    expect(isOrchestratorChatMessagePayload(null)).toBe(true);
  });

  it("blocks known non-chat assistant sources", () => {
    expect(
      isOrchestratorChatMessagePayload({ source: "heartbeat", text: "ping" }),
    ).toBe(false);
    expect(
      isOrchestratorChatMessagePayload({ source: "cron", text: "ping" }),
    ).toBe(false);
    expect(
      isOrchestratorChatMessagePayload({ source: "channel:discord", text: "ping" }),
    ).toBe(false);
  });

  it("respects explicit non-orchestrator agent types", () => {
    expect(
      isOrchestratorChatMessagePayload({ agentType: "general", text: "done" }),
    ).toBe(false);
    expect(
      isOrchestratorChatMessagePayload({
        agentType: "orchestrator",
        text: "done",
      }),
    ).toBe(true);
  });
});
