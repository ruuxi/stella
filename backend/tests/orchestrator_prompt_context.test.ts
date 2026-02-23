import { describe, expect, test } from "bun:test";
import { buildOrchestratorPromptContext } from "../convex/agent/orchestrator_prompt_context";

type FakeConversation = {
  orchestratorReminderHash?: string;
  orchestratorReminderThreadId?: string;
};

const buildCtx = (summary?: string) =>
  ({
    runQuery: async () =>
      summary
        ? {
            summary,
          }
        : null,
  }) as any;

describe("orchestrator prompt context", () => {
  test("does not inject reminder when there is no reminder text", async () => {
    const result = await buildOrchestratorPromptContext(buildCtx(), {
      conversation: {} as FakeConversation as any,
      activeThreadId: null,
      dynamicContext: "",
      extraReminderText: "",
    });

    expect(result.shouldInjectDynamicReminder).toBe(false);
    expect(result.reminderHash).toBe("");
  });

  test("injects reminder when hash changes", async () => {
    const first = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {} as FakeConversation as any,
      activeThreadId: "thread_1" as any,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });
    expect(first.shouldInjectDynamicReminder).toBe(true);

    const second = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {
        orchestratorReminderHash: first.reminderHash,
        orchestratorReminderThreadId: "thread_1",
      } as FakeConversation as any,
      activeThreadId: "thread_1" as any,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });
    expect(second.shouldInjectDynamicReminder).toBe(false);
  });

  test("injects reminder when active thread changes", async () => {
    const base = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {} as FakeConversation as any,
      activeThreadId: "thread_1" as any,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });

    const threadChanged = await buildOrchestratorPromptContext(buildCtx("Summary"), {
      conversation: {
        orchestratorReminderHash: base.reminderHash,
        orchestratorReminderThreadId: "thread_1",
      } as FakeConversation as any,
      activeThreadId: "thread_2" as any,
      dynamicContext: "Device online",
      extraReminderText: "Use concise responses.",
    });

    expect(threadChanged.shouldInjectDynamicReminder).toBe(true);
  });
});
