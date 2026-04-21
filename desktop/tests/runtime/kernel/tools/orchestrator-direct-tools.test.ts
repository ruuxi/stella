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
    taskApi: {
      createTask: async (request) => {
        createdTasks.push({
          description: request.description,
          prompt: request.prompt,
          agentType: request.agentType,
        });
        return { threadId: `thread-${createdTasks.length}` };
      },
      getTask: async () => null,
      cancelTask: async () => ({ canceled: false }),
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
    expect(orchestratorTools.has("TaskCreate")).toBe(true);
    expect(orchestratorTools.has("TaskUpdate")).toBe(true);
    expect(orchestratorTools.has("Display")).toBe(true);
    expect(orchestratorTools.has("WebSearch")).toBe(true);
    expect(orchestratorTools.has("Memory")).toBe(true);

    const generalTools = new Set(host.getToolCatalog("general").map((tool) => tool.name));
    expect(generalTools.has("TaskCreate")).toBe(false);
    expect(generalTools.has("Display")).toBe(false);
    expect(generalTools.has("WebSearch")).toBe(false);
    expect(generalTools.has("Memory")).toBe(false);
    expect(generalTools.has("Exec")).toBe(true);
  });

  it("executes TaskCreate directly for the orchestrator and rejects other agents", async () => {
    const { host, createdTasks } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "TaskCreate",
      {
        description: "Add a notes page",
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
        description: "Add a notes page",
        prompt: "Build the requested notes experience.",
        agentType: "general",
      },
    ]);

    const generalResult = await host.executeTool(
      "TaskCreate",
      {
        description: "Should fail",
        prompt: "This agent should not have direct task creation.",
      },
      makeToolContext("general"),
    );

    expect(generalResult.error).toContain("only available to the orchestrator");
  });
});
