import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { createMemoryInjectionHook } from "../../../../../runtime/extensions/stella-runtime/hooks/memory-injection.hook.js";
import type { ExtensionServices } from "../../../../../runtime/kernel/extensions/services.js";

const createTmpStellaHome = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-memory-hook-"));
  const memories = path.join(root, "state", "memories");
  await mkdir(memories, { recursive: true });
  await writeFile(
    path.join(memories, "memory_summary.md"),
    "Summary from Dream\n",
    "utf8",
  );
  await writeFile(path.join(memories, "MEMORY.md"), "Long memory\n", "utf8");
  return root;
};

const createServices = (args: {
  stellaHome: string;
  initialCounter?: number;
  throwOnReset?: boolean;
}) => {
  let counter = args.initialCounter ?? 0;
  const store = {
    incrementUserTurnsSinceMemoryInjection: vi.fn(() => {
      counter += 1;
      return counter;
    }),
    resetUserTurnsSinceMemoryInjection: vi.fn(() => {
      if (args.throwOnReset) {
        throw new Error("reset failed");
      }
      counter = 1;
    }),
  };
  const memoryStore = {
    loadSnapshot: vi.fn(),
    formatForSystemPrompt: vi.fn((target: "memory" | "user") =>
      target === "user"
        ? "USER PROFILE (who the user is)\nUser prefers concise replies"
        : "MEMORY (your personal notes)\nRemember to keep answers short",
    ),
  };

  return {
    services: {
      stellaHome: args.stellaHome,
      stellaRoot: args.stellaHome,
      store,
      memoryStore,
    } as unknown as Pick<
      ExtensionServices,
      "stellaHome" | "stellaRoot" | "store" | "memoryStore"
    >,
    store,
    memoryStore,
  };
};

describe("createMemoryInjectionHook", () => {
  it("injects memory files and snapshots on the first real orchestrator turn", async () => {
    const stellaHome = await createTmpStellaHome();
    const { services, store, memoryStore } = createServices({ stellaHome });
    const hook = createMemoryInjectionHook(services);

    const result = await hook.handler({
      agentType: AGENT_IDS.ORCHESTRATOR,
      conversationId: "conversation-1",
      userPrompt: "hello",
      isUserTurn: true,
    });

    expect(store.incrementUserTurnsSinceMemoryInjection).toHaveBeenCalledWith(
      "conversation-1",
    );
    expect(store.resetUserTurnsSinceMemoryInjection).not.toHaveBeenCalled();
    expect(memoryStore.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(result?.appendMessages?.map((message) => message.customType)).toEqual([
      "bootstrap.memory_file",
      "bootstrap.memory_file",
      "bootstrap.memory_snapshot",
      "bootstrap.memory_snapshot",
    ]);
    expect(result?.appendMessages?.[0]?.text).toContain(
      '<memory_file path="state/memories/memory_summary.md">',
    );
    expect(result?.appendMessages?.[1]?.text).toContain(
      '<memory_file path="state/memories/MEMORY.md">',
    );
    expect(result?.appendMessages?.[2]?.text).toContain(
      '<memory_snapshot target="user">',
    );
    expect(result?.appendMessages?.[3]?.text).toContain(
      '<memory_snapshot target="memory">',
    );
  });

  it("skips coast turns before the threshold", async () => {
    const stellaHome = await createTmpStellaHome();
    const { services, memoryStore } = createServices({
      stellaHome,
      initialCounter: 1,
    });
    const hook = createMemoryInjectionHook(services);

    const result = await hook.handler({
      agentType: AGENT_IDS.ORCHESTRATOR,
      conversationId: "conversation-1",
      userPrompt: "hello again",
      isUserTurn: true,
    });

    expect(result).toBeUndefined();
    expect(memoryStore.loadSnapshot).not.toHaveBeenCalled();
  });

  it("injects and resets on turn 41", async () => {
    const stellaHome = await createTmpStellaHome();
    const { services, store, memoryStore } = createServices({
      stellaHome,
      initialCounter: 40,
    });
    const hook = createMemoryInjectionHook(services);

    const result = await hook.handler({
      agentType: AGENT_IDS.ORCHESTRATOR,
      conversationId: "conversation-1",
      userPrompt: "threshold",
      isUserTurn: true,
    });

    expect(store.resetUserTurnsSinceMemoryInjection).toHaveBeenCalledWith(
      "conversation-1",
    );
    expect(memoryStore.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(result?.appendMessages?.map((message) => message.customType)).toEqual([
      "bootstrap.memory_file",
      "bootstrap.memory_file",
      "bootstrap.memory_snapshot",
      "bootstrap.memory_snapshot",
    ]);
  });

  it("still injects on threshold turns when reset fails", async () => {
    const stellaHome = await createTmpStellaHome();
    const { services, store, memoryStore } = createServices({
      stellaHome,
      initialCounter: 40,
      throwOnReset: true,
    });
    const hook = createMemoryInjectionHook(services);

    const result = await hook.handler({
      agentType: AGENT_IDS.ORCHESTRATOR,
      conversationId: "conversation-1",
      userPrompt: "threshold",
      isUserTurn: true,
    });

    expect(store.resetUserTurnsSinceMemoryInjection).toHaveBeenCalledTimes(1);
    expect(memoryStore.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(result?.appendMessages?.length).toBeGreaterThan(0);
  });

  it("short-circuits for agent types without dynamic-memory capability", async () => {
    const stellaHome = await createTmpStellaHome();
    const { services, store, memoryStore } = createServices({ stellaHome });
    const hook = createMemoryInjectionHook(services);

    const result = await hook.handler({
      agentType: AGENT_IDS.GENERAL,
      conversationId: "conversation-1",
      userPrompt: "hello",
      isUserTurn: true,
    });

    expect(result).toBeUndefined();
    expect(store.incrementUserTurnsSinceMemoryInjection).not.toHaveBeenCalled();
    expect(memoryStore.loadSnapshot).not.toHaveBeenCalled();
  });

  it("does not inject on hidden/non-user turns", async () => {
    const stellaHome = await createTmpStellaHome();
    const { services, store, memoryStore } = createServices({ stellaHome });
    const hook = createMemoryInjectionHook(services);

    const result = await hook.handler({
      agentType: AGENT_IDS.ORCHESTRATOR,
      conversationId: "conversation-1",
      userPrompt: "hidden",
      isUserTurn: false,
      uiVisibility: "hidden",
    });

    expect(result).toBeUndefined();
    expect(store.incrementUserTurnsSinceMemoryInjection).not.toHaveBeenCalled();
    expect(memoryStore.loadSnapshot).not.toHaveBeenCalled();
  });
});
