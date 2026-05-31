import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

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
  contextLookups: Array<Record<string, unknown>>;
  sourceImports: Array<Record<string, unknown>>;
};

const activeContexts = new Set<TestHostContext>();

const createTestHost = async (
  getSubagentTypes?: () => readonly string[],
): Promise<TestHostContext> => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-orchestrator-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(path.join(rootPath), { recursive: true });

  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);

  const createdTasks: Array<Record<string, unknown>> = [];
  const contextLookups: Array<Record<string, unknown>> = [];
  const sourceImports: Array<Record<string, unknown>> = [];

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
    getSubagentTypes,
    webSearch: async (query) => ({ text: `results for ${query}` }),
    contextProvider: async (payload) => {
      contextLookups.push(payload);
      return "Relevant context for this turn.";
    },
    sourceImportApi: {
      importSource: async (payload) => {
        sourceImports.push(payload);
        return {
          status: "no-changes",
          message: "already imported",
          importRoot: path.join(rootPath, "raw", "source-imports", "test"),
          sourceRoot: rootPath,
          commitHash: null,
        };
      },
    },
  });

  const context = {
    rootPath,
    db,
    host,
    createdTasks,
    contextLookups,
    sourceImports,
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
    expect(orchestratorTools.has("Context")).toBe(true);
    expect(orchestratorTools.has("spawn_agent")).toBe(true);
    expect(orchestratorTools.has("send_input")).toBe(true);
    expect(orchestratorTools.has("pause_agent")).toBe(true);
    expect(orchestratorTools.has("import_source")).toBe(true);
    expect(orchestratorTools.has("Display")).toBe(false);
    expect(orchestratorTools.has("DisplayGuidelines")).toBe(false);
    expect(orchestratorTools.has("image_gen")).toBe(true);
    expect(orchestratorTools.has("web")).toBe(true);
    expect(orchestratorTools.has("Memory")).toBe(false);
    expect(orchestratorTools.has("MemoryNote")).toBe(false);
    expect(orchestratorTools.has("askQuestion")).toBe(false);
    expect(orchestratorTools.has("AskUserQuestion")).toBe(false);
    expect(orchestratorTools.has("Fashion")).toBe(false);

    const spawnAgentTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "spawn_agent");
    expect(
      (
        (spawnAgentTool?.parameters.properties as Record<string, unknown>)
          .agent_type as { enum?: string[] }
      ).enum,
    ).toEqual(["general"]);

    const generalTools = new Set(
      host.getToolCatalog("general").map((tool) => tool.name),
    );
    expect(generalTools.has("spawn_agent")).toBe(false);
    expect(generalTools.has("Display")).toBe(false);
    expect(generalTools.has("DisplayGuidelines")).toBe(false);
    expect(generalTools.has("Memory")).toBe(false);
    expect(generalTools.has("MemoryNote")).toBe(false);
    expect(generalTools.has("Context")).toBe(false);
    expect(generalTools.has("import_source")).toBe(false);
    expect(generalTools.has("askQuestion")).toBe(false);
    expect(generalTools.has("AskUserQuestion")).toBe(false);
    expect(generalTools.has("exec_command")).toBe(true);
    expect(generalTools.has("write_stdin")).toBe(true);
    expect(generalTools.has("apply_patch")).toBe(true);
    expect(generalTools.has("web")).toBe(true);
    expect(generalTools.has("RequestCredential")).toBe(true);
    expect(generalTools.has("view_image")).toBe(true);
    expect(generalTools.has("image_gen")).toBe(false);

    const claudeCodeGeneralTools = new Set(
      host
        .getToolCatalog("general", {
          model: {
            api: "openai-responses",
            provider: "openai",
            id: "gpt-5",
            name: "gpt-5",
          },
          agentEngine: "claude_code_local",
        })
        .map((tool) => tool.name),
    );
    expect(claudeCodeGeneralTools.has("apply_patch")).toBe(false);
    expect(claudeCodeGeneralTools.has("Write")).toBe(true);
    expect(claudeCodeGeneralTools.has("Edit")).toBe(true);

    const claudeCodeOrchestratorTools = new Set(
      host
        .getToolCatalog("orchestrator", {
          model: {
            api: "openai-responses",
            provider: "openai",
            id: "gpt-5",
            name: "gpt-5",
          },
          agentEngine: "claude_code_local",
        })
        .map((tool) => tool.name),
    );
    expect(claudeCodeOrchestratorTools.has("apply_patch")).toBe(false);
    expect(claudeCodeOrchestratorTools.has("Write")).toBe(true);
    expect(claudeCodeOrchestratorTools.has("Edit")).toBe(true);

    const generalImageResult = await host.executeTool(
      "image_gen",
      { prompt: "Generate a small test image." },
      makeToolContext("general"),
    );
    expect(generalImageResult.error).toContain(
      "image_gen is not available to the General agent",
    );

    // Store agent now lives on the backend — the local runtime exposes
    // none of its tools and the orchestrator no longer has a `Store`
    // delegation tool. Sanity-check that's still the case.
    expect(orchestratorTools.has("Store")).toBe(false);

    const fashionTools = new Set(
      host.getToolCatalog("fashion").map((tool) => tool.name),
    );
    expect(fashionTools.has("FashionGetContext")).toBe(true);
    expect(fashionTools.has("FashionSearchProducts")).toBe(true);
    expect(fashionTools.has("FashionCreateOutfit")).toBe(true);
    expect(fashionTools.has("FashionMarkOutfitReady")).toBe(true);
    expect(fashionTools.has("Fashion")).toBe(false);
    expect(fashionTools.has("image_gen")).toBe(true);
  });

  it("executes import_source for the orchestrator and rejects other agents", async () => {
    const { host, sourceImports } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "import_source",
      {
        source: {
          kind: "git",
          url: "https://github.com/example/project.git#main",
        },
        scope: { kind: "feature", label: "command palette" },
        trust: "untrusted",
      },
      makeToolContext("orchestrator"),
    );

    expect(orchestratorResult.error).toBeUndefined();
    expect(orchestratorResult.result).toMatchObject({
      status: "no-changes",
      message: "already imported",
    });
    expect(sourceImports).toHaveLength(1);
    expect(sourceImports[0]).toMatchObject({
      source: {
        kind: "git",
        url: "https://github.com/example/project.git#main",
      },
      scope: { kind: "feature", label: "command palette" },
      trust: "untrusted",
      conversationId: "conv-1",
      requestId: "req-1",
    });

    const generalResult = await host.executeTool(
      "import_source",
      {
        source: { kind: "local-path", path: "/tmp/source" },
      },
      makeToolContext("general"),
    );
    expect(generalResult.error).toContain(
      "import_source is only available to the orchestrator",
    );
  });

  it("executes Context for the orchestrator and rejects other agents", async () => {
    const { host, contextLookups } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "Context",
      {
        prompt: "Find context for what the user means by yesterday's tab.",
        memorySearchTerms: ["yesterday", "tab"],
      },
      makeToolContext("orchestrator"),
    );

    expect(orchestratorResult.error).toBeUndefined();
    expect(orchestratorResult.result).toBe("Relevant context for this turn.");
    expect(contextLookups).toHaveLength(1);
    expect(contextLookups[0]).toMatchObject({
      conversationId: "conv-1",
      requestId: "req-1",
      prompt: "Find context for what the user means by yesterday's tab.",
      memorySearchTerms: ["yesterday", "tab"],
      agentType: "orchestrator",
    });

    const generalResult = await host.executeTool(
      "Context",
      { prompt: "Find context." },
      makeToolContext("general"),
    );

    expect(generalResult.error).toContain("only available to the orchestrator");

    const missingPromptResult = await host.executeTool(
      "Context",
      {},
      makeToolContext("orchestrator"),
    );
    expect(missingPromptResult.error).toContain("Context prompt is required");
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

  it("surfaces custom agent types in spawn_agent schema", async () => {
    const { host } = await createTestHost(() => ["general", "research"]);

    const spawnAgentTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "spawn_agent");

    expect(
      (
        (spawnAgentTool?.parameters.properties as Record<string, unknown>)
          .agent_type as { enum?: string[] }
      ).enum,
    ).toEqual(["general", "research"]);
  });

  it("falls back to general when custom agent type discovery returns empty", async () => {
    const { host } = await createTestHost(() => []);

    const spawnAgentTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "spawn_agent");

    expect(
      (
        (spawnAgentTool?.parameters.properties as Record<string, unknown>)
          .agent_type as { enum?: string[] }
      ).enum,
    ).toEqual(["general"]);
  });
});
