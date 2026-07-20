import { describe, expect, it } from "vitest";
import type { ThreadActivityRecord } from "../../../../runtime/contracts/local-chat.js";
import {
  selectLatestAgentAssistantMessage,
  selectLatestThreadAssistantSummary,
} from "@/features/chat/lib/agent-assistant-summary";

const record = (
  threadId: string,
  overrides: Partial<ThreadActivityRecord> = {},
): ThreadActivityRecord => ({
  threadId,
  conversationId: "conversation-1",
  agentType: "general",
  description: `Work for ${threadId}`,
  status: "running",
  attemptGeneration: 1,
  rootRunId: `run-${threadId}`,
  startedAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

describe("agent assistant summary selection", () => {
  it("selects the latest non-empty chronological assistant message", () => {
    expect(
      selectLatestAgentAssistantMessage([
        "First stable update",
        "  ",
        "Latest accumulated update",
        "\n",
      ]),
    ).toBe("Latest accumulated update");
  });

  it("uses durable insertion sequence when timestamps tie", () => {
    const selected = selectLatestThreadAssistantSummary(
      [
        record("child-a", {
          assistantMessages: ["Earlier append"],
          assistantMessagesUpdatedAt: 2_000,
          assistantMessagesUpdatedSequence: 41,
        }),
        record("child-b", {
          assistantMessages: ["Later append"],
          assistantMessagesUpdatedAt: 2_000,
          assistantMessagesUpdatedSequence: 42,
        }),
      ],
      { threadIds: ["child-a", "child-b"] },
    );

    expect(selected?.text).toBe("Later append");
  });

  it("never selects parent/root text or a different attempt", () => {
    const selected = selectLatestThreadAssistantSummary(
      [
        record("root", {
          assistantMessages: ["Root assistant must stay out"],
          assistantMessagesUpdatedAt: 9_000,
          assistantMessagesUpdatedSequence: 99,
        }),
        record("child", {
          attemptGeneration: 2,
          rootRunId: "child-run-2",
          assistantMessages: ["Current child prose"],
          assistantMessagesUpdatedAt: 3_000,
          assistantMessagesUpdatedSequence: 12,
        }),
      ],
      {
        threadIds: ["child"],
        attemptGenerationsByThread: { child: 2 },
        rootRunIdsByThread: { child: "child-run-2" },
        startedAtMsByThread: { child: 2_000 },
      },
    );

    expect(selected?.text).toBe("Current child prose");
    expect(
      selectLatestThreadAssistantSummary(
        [
          record("child", {
            attemptGeneration: 3,
            assistantMessages: ["Resumed attempt text"],
            assistantMessagesUpdatedAt: 4_000,
          }),
        ],
        {
          threadIds: ["child"],
          attemptGenerationsByThread: { child: 2 },
        },
      ),
    ).toBeUndefined();
  });
});
