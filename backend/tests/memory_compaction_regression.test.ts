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

  test("orchestrator prompt context is built by shared helper in both chat paths", () => {
    const httpSource = readBackendFile("convex/http.ts");
    const taskSource = readBackendFile("convex/agent/tasks.ts");
    expect(httpSource).toContain("buildOrchestratorPromptContext");
    expect(taskSource).toContain("buildOrchestratorPromptContext");
  });

  test("reminder state is marked even when assistant text is empty", () => {
    const httpSource = readBackendFile("convex/http.ts");
    const taskSource = readBackendFile("convex/agent/tasks.ts");

    expect(httpSource).toMatch(
      /if \(text\.trim\(\)\.length > 0\)[\s\S]*?saveAssistantMessage[\s\S]*?\n\s*}\n\s*if \(\n\s*agentType === "orchestrator"[\s\S]*?markOrchestratorReminderSeen/,
    );
    expect(taskSource).toMatch(
      /if \(text\.length > 0 && !noResponseCalled\)[\s\S]*?saveAssistantMessage[\s\S]*?\n\s*}\n\s*if \(\n\s*orchestratorContext\.shouldInjectDynamicReminder[\s\S]*?markOrchestratorReminderSeen/,
    );
  });
});
