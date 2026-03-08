import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const backendRoot = path.resolve(import.meta.dir, "..");

const readBackendFile = (relativePath: string) =>
  readFileSync(path.join(backendRoot, relativePath), "utf-8");

describe("compaction acceptance", () => {
  test("thread compaction defaults match acceptance thresholds", () => {
    const source = readBackendFile("convex/agent/context_budget.ts");
    expect(source).toContain("THREAD_COMPACTION_KEEP_RECENT_TOKENS");
    expect(source).toContain("20_000");
    expect(source).toContain("ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS");
    expect(source).toContain("80_000");
    expect(source).toContain("SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS");
    expect(source).toContain("140_000");
  });

  test("backend orchestrator reminder path was removed", () => {
    const conversationSource = readBackendFile("convex/conversations.ts");

    expect(conversationSource).not.toContain("reminderTokensSinceLastInjection");
    expect(conversationSource).not.toContain("forceReminderOnNextTurn");
    expect(conversationSource).not.toContain("updateReminderTokenCounter");
  });

  test("backend orchestrator files are absent", () => {
    expect(readBackendFile("convex/agent/prompt_builder.ts")).not.toContain('agentType === "orchestrator"');
    expect(() => readBackendFile("convex/agent/orchestrator_turn.ts")).toThrow();
    expect(() => readBackendFile("convex/agent/orchestrator_prompt_context.ts")).toThrow();
  });
});
