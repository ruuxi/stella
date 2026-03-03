import { describe, expect, test } from "bun:test";
import { buildOrchestratorPromptContext } from "../convex/agent/orchestrator_prompt_context";

type FakeConversation = {
  reminderTokensSinceLastInjection?: number | null;
  forceReminderOnNextTurn?: boolean;
};

const buildCtx = (summary?: string) =>
  ({
    runQuery: async () =>
      summary
        ? {
            summary,
          }
        : null,
  }) as unknown;

describe("orchestrator prompt context", () => {
  test("does not inject reminder when there is no reminder text", async () => {
    const result = await buildOrchestratorPromptContext(buildCtx(), {
      conversation: {} as unknown as FakeConversation,
      activeThreadId: null,
      dynamicContext: "",
      extraReminderText: "",
    });

    expect(result.shouldInjectDynamicReminder).toBe(false);
    expect(result.reminderText).toBe("");
  });

  test("injects reminder when hash changes", async () => {
    const first = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {} as unknown as FakeConversation,
      activeThreadId: "thread_1" as unknown as string,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });
    expect(first.shouldInjectDynamicReminder).toBe(true);

    const second = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {
        reminderTokensSinceLastInjection: 0,
      } as unknown as FakeConversation,
      activeThreadId: "thread_1" as unknown as string,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });
    expect(second.shouldInjectDynamicReminder).toBe(false);
  });

  test("injects reminder when active thread changes", async () => {
    const base = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {} as unknown as FakeConversation,
      activeThreadId: "thread_1" as unknown as string,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });

    const threadChanged = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {
        reminderTokensSinceLastInjection: 0,
        forceReminderOnNextTurn: true,
      } as unknown as FakeConversation,
      activeThreadId: "thread_2" as unknown as string,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });

    expect(threadChanged.shouldInjectDynamicReminder).toBe(true);
  });
});
