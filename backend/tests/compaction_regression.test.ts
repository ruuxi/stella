import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const backendRoot = path.resolve(import.meta.dir, "..");

const readBackendFile = (relativePath: string) =>
  readFileSync(path.join(backendRoot, relativePath), "utf-8");

describe("compaction regressions", () => {
  test("compaction thresholds are explicitly pinned to 80k/140k defaults", () => {
    const source = readBackendFile("convex/agent/context_budget.ts");
    expect(source).toContain("ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS");
    expect(source).toContain("80_000");
    expect(source).toContain("SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS");
    expect(source).toContain("140_000");
  });

  test("compactThread applies DB updates through a single finalizing mutation", () => {
    const source = readBackendFile("convex/data/threads.ts");
    expect(source).toContain("export const finalizeThreadCompaction = internalMutation");
    expect(source).toContain("internal.data.threads.finalizeThreadCompaction");
    expect(source).not.toContain("ctx.runMutation(internal.data.threads.deleteMessagesBefore");
    expect(source).not.toContain("patchThreadAfterCompaction");
    expect(source).not.toContain("ctx.runMutation(internal.conversations.setActiveThreadId");
  });

  test("orchestrator turn preparation is shared by chat and task-delivery paths", () => {
    const turnSource = readBackendFile("convex/agent/orchestrator_turn.ts");
    const taskSource = readBackendFile("convex/agent/tasks.ts");
    const automationSource = readBackendFile("convex/automation/runner.ts");
    expect(turnSource).toContain("export const prepareOrchestratorTurn");
    expect(turnSource).toContain("export const finalizeOrchestratorTurn");
    expect(taskSource).toContain("prepareOrchestratorTurn");
    expect(taskSource).toContain("finalizeDeliveredTaskTurn");
    expect(automationSource).toContain("prepareOrchestratorTurn");
    expect(automationSource).toContain("finalizeOrchestratorTurn");
  });

  test("shared orchestrator core marks reminders independently from assistant text persistence", () => {
    const source = readBackendFile("convex/agent/orchestrator_turn.ts");
    expect(source).toMatch(
      /const persistAssistantMessage[\s\S]*?if \(args\.persistThreadFirst\)[\s\S]*?if \(args\.reminderState\.shouldInjectDynamicReminder\)[\s\S]*?updateReminderTokenCounter/,
    );
  });

  test("automation orchestrator turns route through shared prepare/finalize helpers", () => {
    const source = readBackendFile("convex/automation/runner.ts");
    expect(source).toContain("prepareOrchestratorTurn");
    expect(source).toContain("finalizeOrchestratorTurn");
  });

  test("channel inbound user events are not duplicated into prompt history", () => {
    const source = readBackendFile("convex/channels/message_pipeline.ts");
    expect(source).toMatch(/const userMessageId =[\s\S]*appendInboundUserMessage/);
    expect(source).toContain("userMessageId: userMessageId ?? undefined");
  });

  test("task delivery persistence is idempotent via task-level completion marker", () => {
    const taskSource = readBackendFile("convex/agent/tasks.ts");
    const schemaSource = readBackendFile("convex/schema/conversations.ts");
    expect(taskSource).toContain("export const finalizeDeliveredTaskTurn = internalMutation");
    expect(taskSource).toContain("typeof task.deliveryCompletedAt === \"number\"");
    expect(taskSource).toContain("deliveryCompletedAt: now");
    expect(taskSource).toContain("isTaskDeliveryCompleted");
    expect(schemaSource).toContain("deliveryCompletedAt: v.optional(v.number())");
  });
});
