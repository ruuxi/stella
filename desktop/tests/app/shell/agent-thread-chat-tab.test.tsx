// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadActivityUpdatedPayload } from "../../../../runtime/contracts/local-chat.js";
import { AgentThreadChatTab } from "@/shell/display/AgentThreadChatTab";

describe("AgentThreadChatTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listener: ((payload: ThreadActivityUpdatedPayload) => void) | undefined;
  const listAgentThreadMessages = vi.fn();

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    listener = undefined;
    listAgentThreadMessages.mockReset().mockResolvedValue([
      { timestamp: 1, role: "user", content: "Inspect the route." },
      {
        entryId: "assistant-1",
        timestamp: 2,
        role: "assistant",
        content: "I found the durable owner.",
      },
      { timestamp: 3, role: "toolResult", content: "3 checks passed" },
      {
        timestamp: 4,
        role: "runtimeInternal",
        content: "Managed child settled.",
      },
    ]);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listAgentThreadMessages,
          onThreadActivityUpdated: (
            next: (payload: ThreadActivityUpdatedPayload) => void,
          ) => {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "electronAPI");
  });

  it("renders the exact transcript read-only and refreshes on live activity", async () => {
    await act(async () => {
      root.render(
        <AgentThreadChatTab
          threadId="agent-exact-1"
          conversationId="conversation-a"
          agentType="general"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listAgentThreadMessages).toHaveBeenCalledWith({
      threadId: "agent-exact-1",
      limit: 200,
    });
    expect(container.textContent).toContain("I found the durable owner.");
    expect(container.textContent).toContain("3 checks passed");
    expect(container.textContent).toContain("Managed child settled.");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("This thread is read-only");

    listAgentThreadMessages.mockResolvedValueOnce([
      {
        timestamp: 5,
        role: "assistant",
        content: "A newer authored update arrived.",
      },
    ]);
    await act(async () => {
      listener?.({ conversationId: "conversation-other" });
      await Promise.resolve();
    });
    expect(listAgentThreadMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      listener?.({ conversationId: "conversation-a" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("A newer authored update arrived.");
  });
});
