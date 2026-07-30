// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadActivityUpdatedPayload } from "../../../../runtime/contracts/local-chat.js";

const openAgentThreadTab = vi.hoisted(() => vi.fn());
vi.mock("@/features/workspace-display/open-payload", () => ({
  openAgentThreadTab,
}));

const { AgentThreadChatTab } = await import(
  "@/shell/display/AgentThreadChatTab"
);

describe("AgentThreadChatTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootMounted: boolean;
  let listeners: Set<(payload: ThreadActivityUpdatedPayload) => void>;
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
      entryId: "child-start",
      timestamp: 3,
      role: "lifecycle" as const,
      content: "",
      lifecycleEvent: {
        _id: "child:1:agent-started",
        timestamp: 3,
        type: "agent-started",
        payload: {
          agentId: "child",
          agentType: "general",
          description: "Inspect child ownership",
          attemptGeneration: 1,
        },
      },
    },
    {
      entryId: "child-completed",
      timestamp: 4,
      role: "lifecycle" as const,
      content: "",
      lifecycleEvent: {
        _id: "child:1:agent-completed",
        timestamp: 4,
        type: "agent-completed",
        payload: {
          agentId: "child",
          result: "Subagent settled.",
          attemptGeneration: 1,
        },
      },
    },
  ];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    listeners = new Set();
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
    openAgentThreadTab.mockClear();
    listAgentThreadMessages.mockReset().mockResolvedValue(initialMessages);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listAgentThreadMessages,
          onThreadActivityUpdated: (
            next: (payload: ThreadActivityUpdatedPayload) => void,
          ) => {
            listeners.add(next);
            return () => {
              listeners.delete(next);
            };
          },
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
  });

  afterEach(async () => {
    if (rootMounted) await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "electronAPI");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  const renderThread = async (
    threadId = "agent-exact-1",
    conversationId = "conversation-a",
    agentType = "general",
  ) => {
    await act(async () => {
      root.render(
        <AgentThreadChatTab
          threadId={threadId}
          conversationId={conversationId}
          agentType={agentType}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const emitUpdate = (payload: ThreadActivityUpdatedPayload) => {
    for (const listener of listeners) listener(payload);
  };

  it("renders a subagent card that drills into that subagent's own read-only thread", async () => {
    // Viewing a parent agent's thread: its subagent's spawn/completion is a
    // card here, not a transcript line, and the card opens the SUBAGENT's own
    // read-only view — the nested drill-down, one level down from this tab.
    await renderThread("parent-thread-1", "conversation-a", "general");

    const viewButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open agent thread"]',
    );
    expect(viewButton).not.toBeNull();

    await act(async () => {
      viewButton!.click();
      await Promise.resolve();
    });

    expect(openAgentThreadTab).toHaveBeenCalledTimes(1);
    // Targets the child, not the parent whose thread is currently open.
    expect(openAgentThreadTab).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "child",
        conversationId: "conversation-a",
      }),
    );
  });

  it("renders the exact transcript read-only and refreshes on live activity", async () => {
    await renderThread();

    expect(listAgentThreadMessages).toHaveBeenCalledWith({
      threadId: "agent-exact-1",
      limit: 200,
    });
    expect(container.textContent).toContain("I found the durable owner.");
    expect(container.textContent).toContain("Subagent settled.");
    expect(container.querySelector(".agent-completion-card")).not.toBeNull();
    expect(container.textContent).not.toMatch(
      /\[Tool call\]|\[Tool result\]|spawn_agent|3 checks passed/,
    );
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
      emitUpdate({
        conversationId: "conversation-other",
        transcriptUpdate: {
          threadId: "agent-exact-1",
          entryId: "other-conversation-entry",
          atMs: 5,
        },
      });
      emitUpdate({
        conversationId: "conversation-a",
        transcriptUpdate: {
          threadId: "unrelated-thread",
          entryId: "other-thread-entry",
          atMs: 5,
        },
      });
      await Promise.resolve();
    });
    expect(listAgentThreadMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitUpdate({
        conversationId: "conversation-a",
        transcriptUpdate: {
          threadId: "agent-exact-1",
          entryId: "assistant-2",
          atMs: 5,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("A newer authored update arrived.");

    listAgentThreadMessages.mockResolvedValueOnce([
      ...initialMessages,
      {
        entryId: "assistant-generic-refresh",
        timestamp: 5.5,
        role: "assistant",
        content: "A generic lifecycle invalidation refreshed this view.",
      },
    ]);
    await act(async () => {
      emitUpdate({ conversationId: "conversation-a" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "A generic lifecycle invalidation refreshed this view.",
    );

    listAgentThreadMessages.mockResolvedValue([
      {
        entryId: "claude-authored",
        timestamp: 6,
        role: "assistant",
        content: "Claude authored conclusion.",
      },
    ]);
    await act(async () => {
      root.render(null);
      await Promise.resolve();
    });
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
    expect(container.textContent).toContain("Claude authored conclusion.");
    expect(container.textContent).not.toMatch(
      /spawn_agent|\[Tool call\]|\[Tool result\]/,
    );
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
      emitUpdate({
        conversationId: "conversation-a",
        transcriptUpdate: {
          threadId: "agent-exact-1",
          entryId: "assistant-2",
          atMs: 5,
        },
      });
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
      emitUpdate({
        conversationId: "conversation-a",
        transcriptUpdate: {
          threadId: "agent-exact-1",
          entryId: "assistant-3",
          atMs: 6,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(scroll.scrollTop).toBe(1_650);
  });

  it("keeps stale messages visible on refresh failure and retries in place", async () => {
    await renderThread();
    listAgentThreadMessages.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () => {
      emitUpdate({
        conversationId: "conversation-a",
        transcriptUpdate: {
          threadId: "agent-exact-1",
          entryId: "failed-refresh-entry",
          atMs: 8,
        },
      });
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
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    expect(alert?.getAttribute("aria-atomic")).toBe("true");

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

  it("coalesces exact-thread entry bursts for a subagent transcript", async () => {
    await renderThread("subagent-exact", "conversation-subagent", "general");
    listAgentThreadMessages.mockResolvedValueOnce([...initialMessages]);

    await act(async () => {
      for (const [entryId, atMs] of [
        ["tool-call-empty", 8],
        ["tool-result-latest", 9],
        ["tool-result-duplicate-observation", 9],
      ] as const) {
        emitUpdate({
          conversationId: "conversation-subagent",
          transcriptUpdate: { threadId: "subagent-exact", entryId, atMs },
        });
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listAgentThreadMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(
      "Native tool completed without an authored preamble.",
    );
    expect(container.getAttribute("aria-label")).toBeNull();
    expect(
      container.querySelector('section[aria-label="general read-only chat"]'),
    ).not.toBeNull();
  });

  it("ignores stale loads and queued refreshes after reuse or unmount", async () => {
    let resolveOld: ((messages: typeof initialMessages) => void) | undefined;
    listAgentThreadMessages.mockReset().mockImplementationOnce(
      () =>
        new Promise<typeof initialMessages>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await renderThread("old-thread", "old-conversation");

    listAgentThreadMessages.mockResolvedValueOnce([
      {
        entryId: "new-thread-entry",
        timestamp: 20,
        role: "assistant",
        content: "Current reused tab transcript.",
      },
    ]);
    await renderThread("new-thread", "new-conversation");
    await act(async () => {
      resolveOld?.(initialMessages);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Current reused tab transcript.");
    expect(container.textContent).not.toContain("Inspect the route.");

    const callsBeforeUnmount = listAgentThreadMessages.mock.calls.length;
    await act(async () => {
      emitUpdate({
        conversationId: "new-conversation",
        transcriptUpdate: {
          threadId: "new-thread",
          entryId: "queued-at-unmount",
          atMs: 21,
        },
      });
      root.unmount();
      rootMounted = false;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listAgentThreadMessages).toHaveBeenCalledTimes(callsBeforeUnmount);
  });
});
