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

  test("dynamic reminder injection is token-interval gated and persisted", () => {
    const promptSource = readBackendFile("convex/agent/orchestrator_prompt_context.ts");
    const conversationSource = readBackendFile("convex/conversations.ts");

    expect(promptSource).toContain("reminderTokensSinceLastInjection");
    expect(promptSource).toContain("forceReminderOnNextTurn");
    expect(promptSource).toContain("shouldInjectDynamicReminder");
    expect(conversationSource).toContain("updateReminderTokenCounter");
  });

  test("microcompact boundary events continue to be emitted", () => {
    const source = readBackendFile("convex/agent/orchestrator_turn.ts");
    expect(source).toContain('type: "microcompact_boundary"');
  });
});
