import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const backendRoot = path.resolve(import.meta.dir, "..");

const readBackendFile = (relativePath: string) =>
  readFileSync(path.join(backendRoot, relativePath), "utf-8");

describe("memory + compaction regressions", () => {
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
    expect(source).not.toContain("ctx.runMutation(internal.data.threads.patchThreadAfterCompaction");
    expect(source).not.toContain("ctx.runMutation(internal.conversations.setActiveThreadId");
  });

  test("orchestrator turn core is shared by both chat paths", () => {
    const httpSource = readBackendFile("convex/http.ts");
    const taskSource = readBackendFile("convex/agent/tasks.ts");
    expect(httpSource).toContain("prepareOrchestratorTurn");
    expect(httpSource).toContain("finalizeOrchestratorTurn");
    expect(taskSource).toContain("prepareOrchestratorTurn");
    expect(taskSource).toContain("finalizeOrchestratorTurn");
  });

  test("shared orchestrator core marks reminders independently from assistant text persistence", () => {
    const source = readBackendFile("convex/agent/orchestrator_turn.ts");
    expect(source).toMatch(
      /const persistAssistantMessage[\s\S]*?if \(args\.persistThreadFirst\)[\s\S]*?if \(\n\s*args\.reminderState\.shouldInjectDynamicReminder[\s\S]*?markOrchestratorReminderSeen/,
    );
  });
});
