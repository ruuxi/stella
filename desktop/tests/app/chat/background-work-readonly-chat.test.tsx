// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadActivityUpdatedPayload } from "../../../../runtime/contracts/local-chat.js";

const openAgentThreadTab = vi.hoisted(() => vi.fn());
vi.mock("@/features/workspace-display/open-payload", () => ({
  openAgentThreadTab,
}));

const { BackgroundWorkCard } = await import("@/app/chat/BackgroundWorkCard");

describe("BackgroundWorkCard authored update and thread chat", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    openAgentThreadTab.mockClear();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity: vi.fn(async () => [
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
            },
          ]),
          onThreadActivityUpdated: (
            next: (payload: ThreadActivityUpdatedPayload) => void,
          ) => {
            return () => {
              void next;
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

  it("shows the current-attempt authored message and opens the exact thread", async () => {
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={["agent-thread-1"]}
          spawnedAtMs={{}}
          descriptions={{ "agent-thread-1": "Inspect durable routing" }}
          toolActivities={{
            "agent-thread-1": {
              toolCallId: "send-1",
              toolName: "send_input",
              label: "send_input",
              state: "completed",
            },
          }}
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
    expect(container.textContent).toContain("Working · Check the route again");
    expect(container.textContent).not.toContain("finished send_input");

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open read-only chat for Inspect durable routing"]',
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
