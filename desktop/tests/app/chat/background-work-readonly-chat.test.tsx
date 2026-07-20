// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "../../../../runtime/contracts/local-chat.js";
import { __privateThreadActivityStore } from "@/features/chat/services/thread-activity-store";

const openAgentThreadTab = vi.hoisted(() => vi.fn());
vi.mock("@/features/workspace-display/open-payload", () => ({
  openAgentThreadTab,
}));

const { BackgroundWorkCard } = await import("@/app/chat/BackgroundWorkCard");

describe("BackgroundWorkCard authored update and thread chat", () => {
  let container: HTMLDivElement;
  let root: Root;
  let records: ThreadActivityRecord[];
  let updateListener:
    | ((payload: ThreadActivityUpdatedPayload) => void)
    | undefined;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    openAgentThreadTab.mockClear();
    records = [
      {
        threadId: "agent-thread-1",
        conversationId: "conversation-1",
        agentType: "general",
        description: "Inspect durable routing",
        status: "running",
        attemptGeneration: 2,
        rootRunId: "root-attempt-2",
        startedAt: 1_000,
        updatedAt: 3_000,
        assistantMessages: ["I traced the durable routing boundary."],
        assistantMessagesUpdatedAt: 3_000,
        assistantMessagesUpdatedSequence: 30,
      },
    ];
    updateListener = undefined;
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity: vi.fn(async () => records),
          onThreadActivityUpdated: (
            next: (payload: ThreadActivityUpdatedPayload) => void,
          ) => {
            updateListener = next;
            return () => {
              updateListener = undefined;
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
    __privateThreadActivityStore.resetForTests();
    container.remove();
    Reflect.deleteProperty(window, "electronAPI");
  });

  it("keeps assistant prose after tool activity and opens the exact thread", async () => {
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          spawnedAtMs={{}}
          descriptions={{ "agent-thread-1": "Inspect durable routing" }}
          followUpThreadIds={["agent-thread-1"]}
          statusTexts={{ "agent-thread-1": "Check the route again" }}
          cardId="card-1"
          startEventIdsByThread={{ "agent-thread-1": "start-1" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "I traced the durable routing boundary.",
    );
    expect(container.textContent).toContain("Check the route again");
    expect(container.textContent).not.toContain("finished send_input");
    expect(container.textContent).not.toContain("send_input");

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="View activity"]',
    );
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(openAgentThreadTab).toHaveBeenCalledWith({
      threadId: "agent-thread-1",
      conversationId: "conversation-1",
      agentType: "general",
      title: "Inspect durable routing",
    });
  });

  it("uses Working… for an active tool-only child without exposing tool internals", async () => {
    records = [
      {
        ...records[0]!,
        assistantMessages: undefined,
        assistantMessagesUpdatedAt: undefined,
        assistantMessagesUpdatedSequence: undefined,
      },
    ];
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          spawnedAtMs={{}}
          descriptions={{ "agent-thread-1": "Inspect durable routing" }}
          cardId="tool-only-card"
          startEventIdsByThread={{ "agent-thread-1": "start-1" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Working…");
    expect(container.textContent).not.toContain("exec_command");
    expect(container.textContent).not.toContain("exited 0");
  });

  it("keeps the final assistant text after lifecycle completion", async () => {
    records = [
      {
        ...records[0]!,
        status: "completed",
        completedAt: 3_100,
        updatedAt: 3_100,
        assistantMessages: ["The audit is complete and the checks pass."],
        assistantMessagesUpdatedAt: 3_000,
        assistantMessagesUpdatedSequence: 31,
      },
    ];
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          completedThreadIds={["agent-thread-1"]}
          spawnedAtMs={{ "agent-thread-1": 1_000 }}
          descriptions={{ "agent-thread-1": "Inspect durable routing" }}
          cardId="completed-card"
          startEventIdsByThread={{ "agent-thread-1": "start-1" }}
          attemptGenerationsByThread={{ "agent-thread-1": 2 }}
          rootRunIdsByThread={{ "agent-thread-1": "root-attempt-2" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Inspect durable routing");
    expect(container.textContent).toContain(
      "The audit is complete and the checks pass.",
    );
    expect(container.textContent).not.toContain("Completed");
  });

  it("shows the latest stable accumulated assistant text while it streams", async () => {
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          spawnedAtMs={{ "agent-thread-1": 1_000 }}
          descriptions={{ "agent-thread-1": "Inspect durable routing" }}
          cardId="streaming-card"
          startEventIdsByThread={{ "agent-thread-1": "start-1" }}
          attemptGenerationsByThread={{ "agent-thread-1": 2 }}
          rootRunIdsByThread={{ "agent-thread-1": "root-attempt-2" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      updateListener?.({
        conversationId: "conversation-1",
        assistantUpdate: {
          threadId: "agent-thread-1",
          assistantMessages: [
            "I traced the durable routing boundary.",
            "I am now checking the final renderer path.",
          ],
          reasoningSummaries: [],
          latestMessage: "I am now checking the final renderer path.",
          atMs: 3_000,
          atSequence: 31,
          attemptGeneration: 2,
          rootRunId: "root-attempt-2",
        },
      });
    });

    expect(container.textContent).toContain(
      "I am now checking the final renderer path.",
    );
    expect(container.textContent).not.toContain("exec_command");
  });

  it("never projects a resumed attempt's authored text onto its superseded card", async () => {
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          supersededThreadIds={["agent-thread-1"]}
          spawnedAtMs={{ "agent-thread-1": 1_000 }}
          descriptions={{ "agent-thread-1": "First attempt" }}
          cardId="attempt-1-card"
          startEventIdsByThread={{ "agent-thread-1": "start-attempt-1" }}
          attemptGenerationsByThread={{ "agent-thread-1": 1 }}
          rootRunIdsByThread={{ "agent-thread-1": "root-attempt-1" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("First attempt");
    expect(container.textContent).not.toContain(
      "I traced the durable routing boundary.",
    );

    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          spawnedAtMs={{ "agent-thread-1": 1_000 }}
          descriptions={{ "agent-thread-1": "Resumed attempt" }}
          cardId="attempt-2-card"
          startEventIdsByThread={{ "agent-thread-1": "start-attempt-2" }}
          attemptGenerationsByThread={{ "agent-thread-1": 2 }}
          rootRunIdsByThread={{ "agent-thread-1": "root-attempt-2" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "I traced the durable routing boundary.",
    );
    expect(container.textContent).toContain("Resumed attempt");
  });
});
