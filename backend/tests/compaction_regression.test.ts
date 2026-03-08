import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
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

  test("backend fallback no longer depends on orchestrator turn helpers", () => {
    const automationSource = readBackendFile("convex/automation/runner.ts");
    expect(existsSync(path.join(backendRoot, "convex/agent/orchestrator_turn.ts"))).toBe(false);
    expect(existsSync(path.join(backendRoot, "convex/agent/tasks.ts"))).toBe(false);
    expect(automationSource).not.toContain("prepareOrchestratorTurn");
    expect(automationSource).not.toContain("finalizeOrchestratorTurn");
  });

  test("orchestrator reminder helpers were removed from backend conversations", () => {
    const source = readBackendFile("convex/conversations.ts");
    expect(source).not.toContain("updateReminderTokenCounter");
    expect(source).not.toContain("forceReminderOnNextTurn");
  });

  test("automation runner uses direct prompt building for backend fallback", () => {
    const source = readBackendFile("convex/automation/runner.ts");
    expect(source).toContain("buildSystemPrompt");
    expect(source).not.toContain("prepareOrchestratorTurn");
    expect(source).not.toContain("finalizeOrchestratorTurn");
  });

  test("channel inbound user events are not duplicated into prompt history", () => {
    const source = readBackendFile("convex/channels/message_pipeline.ts");
    expect(source).toMatch(/const userMessageId =[\s\S]*appendInboundUserMessage/);
    expect(source).toContain("userMessageId: userMessageId ?? undefined");
  });

  test("task delivery persistence was removed from backend conversation schema", () => {
    const schemaSource = readBackendFile("convex/schema/conversations.ts");
    expect(existsSync(path.join(backendRoot, "convex/agent/tasks.ts"))).toBe(false);
    expect(schemaSource).not.toContain("tasks: defineTable");
    expect(schemaSource).not.toContain("deliveryCompletedAt");
  });
});
