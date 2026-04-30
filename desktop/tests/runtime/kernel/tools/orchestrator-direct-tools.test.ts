import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../../../../../runtime/kernel/memory/memory-store.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import { createToolHost } from "../../../../../runtime/kernel/tools/host.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

type TestHostContext = {
  rootPath: string;
  db: SqliteDatabase;
  host: ReturnType<typeof createToolHost>;
  createdTasks: Array<Record<string, unknown>>;
  displayCalls: string[];
};

const activeContexts = new Set<TestHostContext>();

const createTestHost = async (): Promise<TestHostContext> => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-orchestrator-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(path.join(rootPath, "state"), { recursive: true });

  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, { timeout: 5000 }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);

  const createdTasks: Array<Record<string, unknown>> = [];
  const displayCalls: string[] = [];
  const memoryStore = new MemoryStore(db);

  const host = createToolHost({
    stellaRoot: rootPath,
    agentApi: {
      createAgent: async (request) => {
        createdTasks.push({
          description: request.description,
          prompt: request.prompt,
          agentType: request.agentType,
        });
        return { threadId: `thread-${createdTasks.length}` };
      },
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    },
    displayHtml: (html) => {
      displayCalls.push(html);
    },
    webSearch: async (query) => ({ text: `results for ${query}` }),
    memoryStore,
  });

  const context = {
    rootPath,
    db,
    host,
    createdTasks,
    displayCalls,
  };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    await context.host.shutdown();
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

const makeToolContext = (agentType: string): ToolContext => ({
  conversationId: "conv-1",
  deviceId: "device-1",
  requestId: "req-1",
  agentType,
  storageMode: "local",
});

describe("orchestrator direct tool surface", () => {
  it("shows direct coordination tools only to the orchestrator", async () => {
    const { host } = await createTestHost();

    const orchestratorTools = new Set(
      host.getToolCatalog("orchestrator").map((tool) => tool.name),
    );
    expect(orchestratorTools.has("spawn_agent")).toBe(true);
    expect(orchestratorTools.has("send_input")).toBe(true);
    expect(orchestratorTools.has("pause_agent")).toBe(true);
    expect(orchestratorTools.has("Display")).toBe(true);
    expect(orchestratorTools.has("web")).toBe(true);
    expect(orchestratorTools.has("Memory")).toBe(true);
    expect(orchestratorTools.has("askQuestion")).toBe(true);
    expect(orchestratorTools.has("Fashion")).toBe(false);

    const generalTools = new Set(host.getToolCatalog("general").map((tool) => tool.name));
    expect(generalTools.has("spawn_agent")).toBe(false);
    expect(generalTools.has("Display")).toBe(false);
    expect(generalTools.has("Memory")).toBe(false);
    expect(generalTools.has("askQuestion")).toBe(false);
    expect(generalTools.has("exec_command")).toBe(true);
    expect(generalTools.has("write_stdin")).toBe(true);
    expect(generalTools.has("apply_patch")).toBe(true);
    expect(generalTools.has("web")).toBe(true);
    expect(generalTools.has("RequestCredential")).toBe(true);
    expect(generalTools.has("view_image")).toBe(true);
    expect(generalTools.has("image_gen")).toBe(true);

    // Store agent now lives on the backend — the local runtime exposes
    // none of its tools and the orchestrator no longer has a `Store`
    // delegation tool. Sanity-check that's still the case.
    expect(orchestratorTools.has("Store")).toBe(false);

    const fashionTools = new Set(host.getToolCatalog("fashion").map((tool) => tool.name));
    expect(fashionTools.has("askQuestion")).toBe(false);
    expect(fashionTools.has("FashionGetContext")).toBe(true);
    expect(fashionTools.has("FashionSearchProducts")).toBe(true);
    expect(fashionTools.has("FashionCreateOutfit")).toBe(true);
    expect(fashionTools.has("FashionMarkOutfitReady")).toBe(true);
    expect(fashionTools.has("Fashion")).toBe(false);
    expect(fashionTools.has("image_gen")).toBe(true);
  });

  it("executes askQuestion for user-facing agents and rejects other agents", async () => {
    const { host } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "askQuestion",
      {
        questions: [
          {
            question: "Which option fits best?",
            options: [{ label: "Option A" }, { label: "Option B" }],
            allowOther: true,
          },
        ],
      },
      makeToolContext("orchestrator"),
    );

    expect(orchestratorResult.error).toBeUndefined();
    expect(typeof orchestratorResult.result).toBe("string");
    expect(orchestratorResult.result as string).toContain(
      "Question tray rendered in chat",
    );

    const generalResult = await host.executeTool(
      "askQuestion",
      {
        questions: [
          {
            question: "Should not be allowed",
            options: [{ label: "Nope" }],
          },
        ],
      },
      makeToolContext("general"),
    );

    expect(generalResult.error).toContain("only available to the orchestrator");

    const missingResult = await host.executeTool(
      "askQuestion",
      { questions: [] },
      makeToolContext("orchestrator"),
    );

    expect(missingResult.error).toContain("questions array is required");
  });

  it("executes spawn_agent directly for the orchestrator and rejects other agents", async () => {
    const { host, createdTasks } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "spawn_agent",
      {
        description: "Add a notes page.",
        prompt: "Build the requested notes experience.",
      },
      makeToolContext("orchestrator"),
    );

    expect(orchestratorResult.error).toBeUndefined();
    expect(orchestratorResult.result).toMatchObject({
      thread_id: "thread-1",
      created: true,
      running_in_background: true,
    });
    expect(createdTasks).toEqual([
      {
        description: "Add a notes page.",
        prompt: "Build the requested notes experience.",
        agentType: "general",
      },
    ]);

    const generalResult = await host.executeTool(
      "spawn_agent",
      {
        description: "Should fail",
        prompt: "This agent should not have direct task creation.",
      },
      makeToolContext("general"),
    );

    expect(generalResult.error).toContain("only available to the orchestrator");
  });
});
