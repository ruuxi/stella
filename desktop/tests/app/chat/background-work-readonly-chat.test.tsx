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
        modelConfigSnapshot: {
          engine: "default",
          routeModel: "stella/anthropic/claude-sonnet-4-5",
        },
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
    const card = container.querySelector(".background-work-card");
    expect(card?.getAttribute("data-lifecycle-status")).toBe("running");
    expect(card?.querySelector(".stella-icon-circle-dot")).not.toBeNull();
    expect(card?.querySelector(".stella-icon-check-circle")).toBeNull();

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open agent thread"]',
    );
    expect(button).not.toBeNull();
    const modelIcon = button?.querySelector(".agent-model-icon");
    expect(modelIcon?.getAttribute("data-brand")).toBe("anthropic");
    expect(modelIcon?.getAttribute("title")).toBe(
      "stella/anthropic/claude-sonnet-4-5",
    );
    await act(async () => button?.click());
    expect(openAgentThreadTab).toHaveBeenCalledWith({
      threadId: "agent-thread-1",
      conversationId: "conversation-1",
      agentType: "general",
      title: "Inspect durable routing",
    });

    openAgentThreadTab.mockClear();
    await act(async () =>
      card?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(openAgentThreadTab).toHaveBeenCalledWith({
      threadId: "agent-thread-1",
      conversationId: "conversation-1",
      agentType: "general",
      title: "Inspect durable routing",
    });
  });

  it("shimmers every simultaneously running inline agent card", async () => {
    records = [
      records[0]!,
      {
        ...records[0]!,
        threadId: "agent-thread-2",
        description: "Verify concurrent work",
        rootRunId: "root-attempt-2b",
      },
    ];

    await act(async () => {
      root.render(
        <>
          <BackgroundWorkCard
            threadIds={["agent-thread-1"]}
            spawnedAtMs={{ "agent-thread-1": 1_000 }}
            descriptions={{
              "agent-thread-1": "Inspect durable routing",
            }}
            cardId="concurrent-card-1"
            startEventIdsByThread={{
              "agent-thread-1": "start-1",
            }}
            conversationId="conversation-1"
          />
          <BackgroundWorkCard
            threadIds={["agent-thread-2"]}
            spawnedAtMs={{ "agent-thread-2": 1_000 }}
            descriptions={{
              "agent-thread-2": "Verify concurrent work",
            }}
            cardId="concurrent-card-2"
            startEventIdsByThread={{
              "agent-thread-2": "start-2",
            }}
            conversationId="conversation-1"
          />
        </>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelectorAll(".background-work-card")).toHaveLength(
      2,
    );
    expect(
      container.querySelectorAll(
        ".background-work-card .text-shimmer__sweep",
      ),
    ).toHaveLength(2);
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
    const card = container.querySelector(".background-work-card");
    expect(card?.getAttribute("data-lifecycle-status")).toBe("completed");
    expect(card?.querySelector(".stella-icon-check-circle")).not.toBeNull();
    expect(card?.querySelector(".stella-icon-circle-dot")).toBeNull();
  });

  it("never pairs a terminal icon with the Working… fallback", async () => {
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
          descriptions={{ "agent-thread-1": "Original task" }}
          followUpThreadIds={["agent-thread-1"]}
          statusTexts={{
            "agent-thread-1":
              "Stop milestone spam — report only a blocker or final completion",
          }}
          cardId="resumed-follow-up"
          startEventIdsByThread={{ "agent-thread-1": "start-follow-up" }}
          attemptGenerationsByThread={{ "agent-thread-1": 2 }}
          rootRunIdsByThread={{ "agent-thread-1": "root-attempt-2" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = container.querySelector(".background-work-card");
    expect(card?.textContent).toContain("Working…");
    expect(card?.getAttribute("data-lifecycle-status")).toBe("running");
    expect(card?.querySelector(".stella-icon-circle-dot")).not.toBeNull();
    expect(card?.querySelector(".stella-icon-check-circle")).toBeNull();
  });

  it("keeps a long-running resumed parent-agent card active past the old timeout", async () => {
    records = [
      {
        ...records[0]!,
        threadId: "v2-parity-parent",
        agentType: "general",
        description: "Resume v2 parity reconciliation after an empty turn",
        status: "running",
        attemptGeneration: 19,
        rootRunId: "v2-parity-run",
        startedAt: Date.now() - 60_000,
        updatedAt: Date.now(),
        assistantMessages: undefined,
        assistantMessagesUpdatedAt: undefined,
        assistantMessagesUpdatedSequence: undefined,
      },
      {
        ...records[0]!,
        threadId: "finished-child",
        agentType: "general",
        description: "Return the current ledger",
        status: "completed",
        attemptGeneration: 3,
        rootRunId: "v2-parity-run",
        parentAgentId: "v2-parity-parent",
        startedAt: Date.now() - 120_000,
        completedAt: Date.now() - 30_000,
        updatedAt: Date.now() - 30_000,
      },
      {
        ...records[0]!,
        threadId: "active-child",
        agentType: "general",
        description: "Implement Batch 1",
        status: "running",
        attemptGeneration: 15,
        rootRunId: "v2-parity-run",
        parentAgentId: "v2-parity-parent",
        startedAt: Date.now() - 45_000,
        updatedAt: Date.now(),
      },
    ];
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["v2-parity-parent"]}
          spawnedAtMs={{
            "v2-parity-parent": Date.now() - 10 * 60_000,
          }}
          descriptions={{
            "v2-parity-parent":
              "Resume v2 parity reconciliation after an empty turn",
          }}
          followUpThreadIds={["v2-parity-parent"]}
          statusTexts={{
            "v2-parity-parent":
              "Resume v2 parity reconciliation after an empty turn",
          }}
          cardId="v2-parity-follow-up"
          startEventIdsByThread={{ "v2-parity-parent": "parent-start-3" }}
          attemptGenerationsByThread={{ "v2-parity-parent": 3 }}
          rootRunIdsByThread={{ "v2-parity-parent": "v2-parity-run" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = container.querySelector(".background-work-card");
    expect(card?.textContent).toContain("Working…");
    expect(card?.getAttribute("data-lifecycle-status")).toBe("running");
    expect(card?.querySelector(".stella-icon-circle-dot")).not.toBeNull();
    expect(card?.querySelector(".stella-icon-check-circle")).toBeNull();
  });

  it("does not complete a parent agent while an owned subagent remains active", async () => {
    records = [
      {
        ...records[0]!,
        threadId: "parent-thread",
        agentType: "general",
        status: "completed",
        attemptGeneration: 4,
        rootRunId: "parent-run",
        completedAt: 4_000,
        updatedAt: 4_000,
        assistantMessages: undefined,
        assistantMessagesUpdatedAt: undefined,
        assistantMessagesUpdatedSequence: undefined,
      },
      {
        ...records[0]!,
        threadId: "parent-child",
        parentAgentId: "parent-thread",
        status: "running",
        attemptGeneration: 2,
        rootRunId: "parent-run",
        updatedAt: 4_100,
      },
    ];
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["parent-thread"]}
          completedThreadIds={["parent-thread"]}
          spawnedAtMs={{ "parent-thread": 1_000 }}
          descriptions={{ "parent-thread": "Coordinate the migration" }}
          cardId="parent-active-descendant"
          startEventIdsByThread={{ "parent-thread": "parent-start" }}
          attemptGenerationsByThread={{ "parent-thread": 4 }}
          rootRunIdsByThread={{ "parent-thread": "parent-run" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container
        .querySelector(".background-work-card")
        ?.getAttribute("data-lifecycle-status"),
    ).toBe("running");
    expect(container.textContent).toContain("Working…");
  });

  it("lets an ordinary General follow-up clear stale completion immediately", async () => {
    records = [
      {
        ...records[0]!,
        status: "running",
        attemptGeneration: 3,
        rootRunId: "general-follow-up-run",
        startedAt: 5_000,
        updatedAt: 5_100,
        assistantMessages: undefined,
        assistantMessagesUpdatedAt: undefined,
        assistantMessagesUpdatedSequence: undefined,
      },
    ];
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          completedThreadIds={["agent-thread-1"]}
          spawnedAtMs={{ "agent-thread-1": 5_000 }}
          descriptions={{ "agent-thread-1": "Reconcile the final diff" }}
          followUpThreadIds={["agent-thread-1"]}
          statusTexts={{ "agent-thread-1": "Recheck the final diff" }}
          cardId="general-follow-up"
          startEventIdsByThread={{ "agent-thread-1": "general-start-3" }}
          attemptGenerationsByThread={{ "agent-thread-1": 3 }}
          rootRunIdsByThread={{
            "agent-thread-1": "general-follow-up-run",
          }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container
        .querySelector(".background-work-card")
        ?.getAttribute("data-lifecycle-status"),
    ).toBe("running");
    expect(container.textContent).toContain("Working…");
  });

  it("shows Completed once the resumed parent agent and its subagents settle", async () => {
    records = [
      {
        ...records[0]!,
        threadId: "settled-parent",
        agentType: "general",
        status: "completed",
        attemptGeneration: 6,
        rootRunId: "settled-run",
        completedAt: 7_000,
        updatedAt: 7_000,
        assistantMessages: undefined,
        assistantMessagesUpdatedAt: undefined,
        assistantMessagesUpdatedSequence: undefined,
      },
      {
        ...records[0]!,
        threadId: "settled-child",
        parentAgentId: "settled-parent",
        status: "completed",
        attemptGeneration: 2,
        rootRunId: "settled-run",
        completedAt: 6_900,
        updatedAt: 6_900,
      },
    ];
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["settled-parent"]}
          completedThreadIds={["settled-parent"]}
          spawnedAtMs={{ "settled-parent": 6_000 }}
          descriptions={{ "settled-parent": "Finish reconciliation" }}
          cardId="settled-parent-card"
          startEventIdsByThread={{ "settled-parent": "parent-start-6" }}
          attemptGenerationsByThread={{ "settled-parent": 6 }}
          rootRunIdsByThread={{ "settled-parent": "settled-run" }}
          conversationId="conversation-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = container.querySelector(".background-work-card");
    expect(card?.getAttribute("data-lifecycle-status")).toBe("completed");
    expect(container.textContent).toContain("Completed");
    expect(card?.querySelector(".stella-icon-check-circle")).not.toBeNull();
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
    expect(
      container
        .querySelector(".background-work-card")
        ?.getAttribute("data-lifecycle-status"),
    ).toBe("completed");

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
