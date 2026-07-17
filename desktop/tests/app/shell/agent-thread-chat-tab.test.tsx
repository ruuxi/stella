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
  let mockScrollHeight: number;
  let mockClientHeight: number;
  const listAgentThreadMessages = vi.fn();
  const initialMessages = [
    {
      entryId: "user-1",
      timestamp: 1,
      role: "user" as const,
      content: "Inspect the route.",
    },
    {
      entryId: "assistant-1",
      timestamp: 2,
      role: "assistant" as const,
      content: "I found the durable owner.",
    },
    {
      entryId: "tool-1",
      timestamp: 3,
      role: "toolResult" as const,
      content: "3 checks passed",
    },
    {
      entryId: "coordination-1",
      timestamp: 4,
      role: "runtimeInternal" as const,
      content: "Managed child settled.",
    },
  ];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    listener = undefined;
    mockScrollHeight = 1_200;
    mockClientHeight = 300;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("agent-thread-chat__scroll")
          ? mockScrollHeight
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("agent-thread-chat__scroll")
          ? mockClientHeight
          : 0;
      },
    });
    listAgentThreadMessages.mockReset().mockResolvedValue(initialMessages);
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
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  const renderThread = async (
    threadId = "agent-exact-1",
    conversationId = "conversation-a",
  ) => {
    await act(async () => {
      root.render(
        <AgentThreadChatTab
          threadId={threadId}
          conversationId={conversationId}
          agentType="general"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("renders the exact transcript read-only and refreshes on live activity", async () => {
    await renderThread();

    expect(listAgentThreadMessages).toHaveBeenCalledWith({
      threadId: "agent-exact-1",
      limit: 200,
    });
    expect(container.textContent).toContain("I found the durable owner.");
    expect(container.textContent).toContain("3 checks passed");
    expect(container.textContent).toContain("Managed child settled.");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("Read-only agent thread");
    expect(container.textContent).not.toContain("explicit follow-up action");
    const scroll = container.querySelector(".agent-thread-chat__scroll");
    expect(scroll?.hasAttribute("aria-live")).toBe(false);
    expect(
      container.querySelector(
        '.agent-thread-chat__announcement[role="status"]',
      ),
    ).not.toBeNull();

    listAgentThreadMessages.mockResolvedValueOnce([
      ...initialMessages,
      {
        entryId: "assistant-2",
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

  it("opens at the newest message, follows while pinned, and preserves manual reading", async () => {
    await renderThread();
    const scroll = container.querySelector<HTMLDivElement>(
      ".agent-thread-chat__scroll",
    )!;
    expect(scroll.scrollTop).toBe(1_200);

    scroll.scrollTop = 700;
    await act(async () => scroll.dispatchEvent(new Event("scroll")));

    mockScrollHeight = 1_500;
    listAgentThreadMessages.mockResolvedValueOnce([
      ...initialMessages,
      {
        entryId: "assistant-2",
        timestamp: 5,
        role: "assistant",
        content: "Update while you were reading.",
      },
    ]);
    await act(async () => {
      listener?.({ conversationId: "conversation-a" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(scroll.scrollTop).toBe(700);
    const newMessageButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show 1 new message"]',
    );
    expect(newMessageButton).not.toBeNull();
    expect(
      container.querySelector(".agent-thread-chat__announcement")?.textContent,
    ).toContain("Latest agent: Update while you were reading.");

    await act(async () => newMessageButton?.click());
    expect(scroll.scrollTop).toBe(1_500);
    expect(
      container.querySelector(".agent-thread-chat__new-messages"),
    ).toBeNull();

    mockScrollHeight = 1_650;
    listAgentThreadMessages.mockResolvedValueOnce([
      ...initialMessages,
      {
        entryId: "assistant-2",
        timestamp: 5,
        role: "assistant",
        content: "Update while you were reading.",
      },
      {
        entryId: "assistant-3",
        timestamp: 6,
        role: "assistant",
        content: "Newest pinned update.",
      },
    ]);
    await act(async () => {
      listener?.({ conversationId: "conversation-a" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(scroll.scrollTop).toBe(1_650);
  });

  it("keeps stale messages visible on refresh failure and retries in place", async () => {
    await renderThread();
    listAgentThreadMessages.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () => {
      listener?.({ conversationId: "conversation-a" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("I found the durable owner.");
    const alert = container.querySelector<HTMLElement>(
      '.agent-thread-chat__refresh-error[role="alert"]',
    );
    expect(alert?.textContent).toContain(
      "Couldn’t refresh this thread. Connection lost",
    );

    listAgentThreadMessages.mockResolvedValueOnce([
      ...initialMessages,
      {
        entryId: "assistant-recovered",
        timestamp: 7,
        role: "assistant",
        content: "Refresh recovered.",
      },
    ]);
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Refresh recovered.");
    expect(
      container.querySelector(".agent-thread-chat__refresh-error"),
    ).toBeNull();
  });

  it("resets and follows latest when an existing tab is reused for another thread", async () => {
    await renderThread();
    mockScrollHeight = 900;
    listAgentThreadMessages.mockResolvedValueOnce([
      {
        entryId: "other-latest",
        timestamp: 20,
        role: "assistant",
        content: "Different thread latest message.",
      },
    ]);
    await renderThread("agent-exact-2");

    expect(container.textContent).toContain("Different thread latest message.");
    expect(container.textContent).not.toContain("I found the durable owner.");
    expect(
      container.querySelector<HTMLDivElement>(".agent-thread-chat__scroll")
        ?.scrollTop,
    ).toBe(900);
  });
});
