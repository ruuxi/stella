import { mkdir, rm, writeFile } from "node:fs/promises";
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
import {
  createPiTools,
  getRuntimeToolMetadata,
} from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";
import { loadParsedAgentsFromDir } from "../../../../../runtime/kernel/agents/markdown-agent-loader.js";
import { loadStellaRuntimeAgents } from "../../../../../runtime/extensions/stella-runtime/index.js";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";

type TestHostContext = {
  rootPath: string;
  db: SqliteDatabase;
  host: ReturnType<typeof createToolHost>;
  createdTasks: Array<Record<string, unknown>>;
  contextLookups: Array<Record<string, unknown>>;
  sourceImports: Array<Record<string, unknown>>;
};

const activeContexts = new Set<TestHostContext>();
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

const createTestHost = async (
  validateSpawnModel?: (modelName: string) => void,
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
    stellaAppDir: rootPath,
    agentApi: {
      createAgent: async (request) => {
        createdTasks.push({
          description: request.description,
          prompt: request.prompt,
          agentType: request.agentType,
          ...(request.model ? { model: request.model } : {}),
          ...(request.spawnEngine ? { spawnEngine: request.spawnEngine } : {}),
          ...(request.modelConfigSnapshot
            ? { modelConfigSnapshot: request.modelConfigSnapshot }
            : {}),
        });
        return { threadId: `thread-${createdTasks.length}` };
      },
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    },
    validateSpawnModel,
    webSearch: async (query) => ({ text: `results for ${query}` }),
    contextProvider: async (payload) => {
      contextLookups.push(payload);
      return {
        status: "found" as const,
        brief: "Relevant context for this turn.",
      };
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
  runId: "run-1",
  agentType,
  storageMode: "local",
  ...(agentType === AGENT_IDS.ORCHESTRATOR
    ? {
        modelConfigSnapshot: {
          engine: "default" as const,
          routeModel: "stella/openai/gpt-5.6-sol",
          reasoningEffort: "high" as const,
        },
      }
    : {}),
});

describe("orchestrator direct tool surface", () => {
  it("keeps orchestrator capabilities readable by the pre-metadata-only loader", () => {
    const agents = loadParsedAgentsFromDir(
      path.join(repoRoot, "runtime/extensions/stella-runtime/agent-metadata"),
    );
    const orchestrator = agents.find((agent) => agent.id === "orchestrator");

    expect(orchestrator?.toolsAllowlist).toEqual(
      expect.arrayContaining(["spawn_agent", "send_input", "pause_agent"]),
    );
    expect(orchestrator?.toolsAllowlist).not.toContain("spawn_manager");
    expect(orchestrator?.maxAgentDepth).toBe(2);
  });

  it("overlays shipped capability metadata onto customized home prompt bodies", async () => {
    const { host, rootPath } = await createTestHost();
    const agentsDir = path.join(rootPath, "agents");
    await mkdir(agentsDir, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(agentsDir, "orchestrator.md"),
        [
          "---",
          "name: Customized Orchestrator",
          "description: stale orchestrator metadata",
          "tools: spawn_agent, send_input, pause_agent",
          "maxAgentDepth: 1",
          "---",
          "My customized orchestrator prompt.",
        ].join("\n"),
      ),
      writeFile(
        path.join(agentsDir, "general.md"),
        [
          "---",
          "name: Customized General",
          "description: overly broad general metadata",
          "tools: spawn_agent, spawn_manager, send_input, pause_agent, report",
          "maxAgentDepth: 9",
          "---",
          "My customized general prompt.",
        ].join("\n"),
      ),
    ]);

    const agents = loadStellaRuntimeAgents(
      rootPath,
      path.join(repoRoot, "runtime/extensions/stella-runtime/agent-metadata"),
    );
    const advertisedToolNames = (agentType: string) => {
      const agent = agents.find((candidate) => candidate.id === agentType);
      expect(agent).toBeDefined();
      return getRuntimeToolMetadata({
        toolsAllowlist: agent?.toolsAllowlist,
        toolCatalog: host.getToolCatalog(agentType),
      }).map((tool) => tool.name);
    };

    expect(
      agents.find((agent) => agent.id === "orchestrator")?.systemPrompt,
    ).toBe("My customized orchestrator prompt.");
    expect(advertisedToolNames("orchestrator")).toEqual(
      expect.arrayContaining(["spawn_agent", "send_input", "pause_agent"]),
    );
    // The customized home body is kept, but its stale/overly broad capability
    // frontmatter is replaced wholesale by the shipped metadata: General keeps
    // the real delegation tools, loses tools that no longer exist, and its
    // depth cap comes from the shipped record rather than the home file.
    const general = agents.find((agent) => agent.id === "general");
    expect(general?.systemPrompt).toBe("My customized general prompt.");
    expect(general?.maxAgentDepth).toBe(2);
    const generalToolNames = advertisedToolNames("general");
    expect(generalToolNames).toEqual(
      expect.arrayContaining(["spawn_agent", "send_input", "pause_agent"]),
    );
    for (const removedTool of ["spawn_manager", "report"]) {
      expect(generalToolNames).not.toContain(removedTool);
    }
  });

  it("loads and executes General delegation tools through the production adapter path", async () => {
    const { host, rootPath, createdTasks } = await createTestHost();
    const agentsDir = path.join(rootPath, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      path.join(agentsDir, "general.md"),
      [
        "---",
        "name: general",
        "description: general prompt",
        "tools: stale_home_metadata",
        "---",
        "Customized general production prompt.",
      ].join("\n"),
    );

    const loaded = loadStellaRuntimeAgents(
      rootPath,
      path.join(repoRoot, "runtime/extensions/stella-runtime/agent-metadata"),
    );
    const general = loaded.find((agent) => agent.id === AGENT_IDS.GENERAL);
    expect(general?.toolsAllowlist).toContain("spawn_agent");

    const generalTools = createPiTools({
      runId: "general-run",
      rootRunId: "root-run",
      agentId: "general-thread",
      conversationId: "conv-1",
      agentType: AGENT_IDS.GENERAL,
      deviceId: "device-1",
      stellaAppDir: rootPath,
      stellaDataDir: rootPath,
      toolsAllowlist: general?.toolsAllowlist,
      toolCatalog: host.getToolCatalog(AGENT_IDS.GENERAL),
      store: {} as never,
      toolExecutor: host.executeTool,
    });
    const toolNames = generalTools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["spawn_agent", "send_input", "pause_agent"]),
    );
    expect(toolNames).not.toContain("report");
    expect(toolNames).not.toContain("spawn_manager");
    expect(
      host.getToolCatalog(AGENT_IDS.GENERAL).map((tool) => tool.name),
    ).not.toContain("report");

    const spawnTool = generalTools.find((tool) => tool.name === "spawn_agent");
    expect(spawnTool).toBeDefined();
    await spawnTool!.execute("call-spawn", {
      description: "Subagent work",
      prompt: "Do the delegated piece.",
    });
    expect(createdTasks).toEqual([
      {
        description: "Subagent work",
        prompt: "Do the delegated piece.",
        agentType: "general",
      },
    ]);
  });

  it("gives a parent-owned General the same toolset minus the orchestration tools", async () => {
    const { host, rootPath } = await createTestHost();
    const general = loadParsedAgentsFromDir(
      path.join(repoRoot, "runtime/extensions/stella-runtime/agent-metadata"),
    ).find((agent) => agent.id === AGENT_IDS.GENERAL);
    const allowlist = general?.toolsAllowlist ?? [];
    expect(allowlist).toEqual(
      expect.arrayContaining(["exec_command", "spawn_agent"]),
    );
    const orchestrationTools = ["spawn_agent", "send_input", "pause_agent"];

    const topLevelCatalog = host
      .getToolCatalog(AGENT_IDS.GENERAL)
      .map((tool) => tool.name);
    const parentOwnedCatalog = host
      .getToolCatalog(AGENT_IDS.GENERAL, { parentOwned: true })
      .map((tool) => tool.name);

    // Top-level General has all three; a parent-owned one has none of them.
    expect(topLevelCatalog).toEqual(expect.arrayContaining(orchestrationTools));
    for (const toolName of orchestrationTools) {
      expect(parentOwnedCatalog).not.toContain(toolName);
    }
    // ...and the two catalogs are otherwise identical, so a subagent keeps
    // shell, files, browser, search and skills exactly as a top-level General.
    expect(parentOwnedCatalog.slice().sort()).toEqual(
      topLevelCatalog
        .filter((name) => !orchestrationTools.includes(name))
        .sort(),
    );

    // The allowlist is the authoritative activation list — a name on it that
    // is absent from the catalog is still registered against synthesized
    // metadata — so the parent-owned tier must prune it too, not just the
    // catalog. This mirrors what LocalAgentManager does for a parented task.
    const parentOwnedAllowlist = allowlist.filter(
      (name) => !orchestrationTools.includes(name),
    );
    const subagentTools = createPiTools({
      runId: "subagent-run",
      rootRunId: "root-run",
      agentId: "subagent-thread",
      parentAgentId: "parent-thread",
      conversationId: "conv-1",
      agentType: AGENT_IDS.GENERAL,
      deviceId: "device-1",
      stellaAppDir: rootPath,
      stellaDataDir: rootPath,
      toolsAllowlist: parentOwnedAllowlist,
      toolCatalog: host.getToolCatalog(AGENT_IDS.GENERAL, {
        parentOwned: true,
      }),
      store: {} as never,
      toolExecutor: host.executeTool,
    }).map((tool) => tool.name);
    for (const toolName of orchestrationTools) {
      expect(subagentTools).not.toContain(toolName);
    }
    expect(subagentTools).toContain("exec_command");

    // Defense in depth: even a hallucinated call is refused at execute time
    // on the strength of the thread's ownership alone.
    const denied = await host.executeTool(
      "spawn_agent",
      { description: "Third level", prompt: "Should never run." },
      {
        conversationId: "conv-1",
        deviceId: "device-1",
        requestId: "call-denied",
        agentType: AGENT_IDS.GENERAL,
        agentId: "subagent-thread",
        parentAgentId: "parent-thread",
      },
    );
    expect(denied.error).toContain("not available to a subagent");
  });

  it("shows direct coordination tools to the orchestrator and General agents", async () => {
    const { host } = await createTestHost();

    const orchestratorTools = new Set(
      host.getToolCatalog("orchestrator").map((tool) => tool.name),
    );
    expect(orchestratorTools.has("Recall")).toBe(true);
    expect(orchestratorTools.has("Remember")).toBe(true);
    expect(orchestratorTools.has("search_threads")).toBe(false);
    expect(orchestratorTools.has("spawn_agent")).toBe(true);
    expect(orchestratorTools.has("spawn_manager")).toBe(false);
    expect(orchestratorTools.has("send_input")).toBe(true);
    expect(orchestratorTools.has("pause_agent")).toBe(true);
    expect(orchestratorTools.has("import_source")).toBe(true);
    expect(orchestratorTools.has("Display")).toBe(false);
    expect(orchestratorTools.has("DisplayGuidelines")).toBe(false);
    expect(orchestratorTools.has("image_gen")).toBe(true);
    expect(orchestratorTools.has("web")).toBe(true);
    expect(orchestratorTools.has("tool_search")).toBe(true);
    expect(orchestratorTools.has("linq_send_message")).toBe(false);
    expect(orchestratorTools.has("Memory")).toBe(false);
    expect(orchestratorTools.has("MemoryNote")).toBe(false);
    expect(orchestratorTools.has("askQuestion")).toBe(false);
    expect(orchestratorTools.has("AskUserQuestion")).toBe(false);
    expect(orchestratorTools.has("Fashion")).toBe(false);

    const spawnAgentTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "spawn_agent");
    const sendInputTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "send_input");
    const spawnAgentProperties = spawnAgentTool?.parameters.properties as
      | Record<string, unknown>
      | undefined;
    expect(spawnAgentProperties?.agent_type).toBeUndefined();
    expect(spawnAgentProperties?.group).toBeUndefined();
    expect(spawnAgentProperties?.model).toMatchObject({ type: "string" });
    expect(
      spawnAgentTool?.parameters.required as string[] | undefined,
    ).not.toContain("model");
    expect(
      (sendInputTool?.parameters.properties as Record<string, unknown>)
        .description,
    ).toMatchObject({
      description:
        "One short, user-friendly sentence summarizing what this work is about.",
    });
    expect(
      Object.keys(
        (sendInputTool?.parameters.properties as Record<string, unknown>) ?? {},
      ),
    ).toEqual(["thread_id", "description", "message"]);
    expect(sendInputTool?.parameters.required).toEqual([
      "thread_id",
      "description",
      "message",
    ]);
    expect(
      sendInputTool?.parameters.required as string[] | undefined,
    ).toContain("description");

    const generalTools = new Set(
      host.getToolCatalog("general").map((tool) => tool.name),
    );
    expect(generalTools.has("spawn_agent")).toBe(true);
    expect(generalTools.has("send_input")).toBe(true);
    expect(generalTools.has("pause_agent")).toBe(true);
    expect(generalTools.has("spawn_manager")).toBe(false);
    expect(generalTools.has("report")).toBe(false);
    expect(generalTools.has("linq_send_message")).toBe(false);
    expect(generalTools.has("Display")).toBe(false);
    expect(generalTools.has("DisplayGuidelines")).toBe(false);
    expect(generalTools.has("Memory")).toBe(false);
    expect(generalTools.has("MemoryNote")).toBe(false);
    expect(generalTools.has("Recall")).toBe(false);
    expect(generalTools.has("Remember")).toBe(false);
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
      "image_gen is only available to the orchestrator",
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

  it("hides the delegation tools from agents that are not spawners", async () => {
    const { host } = await createTestHost();
    for (const agentType of ["explore", "fashion", "schedule"]) {
      const coordinationTools = host
        .getToolCatalog(agentType)
        .filter((tool) =>
          ["spawn_agent", "send_input", "pause_agent"].includes(tool.name),
        )
        .map((tool) => tool.name);
      expect(coordinationTools).toEqual([]);
    }

    const nestedResult = await host.executeTool(
      "spawn_agent",
      { description: "Nested work", prompt: "Should not run." },
      makeToolContext("explore"),
    );
    expect(nestedResult.error).toContain("only available");
  });

  it("keeps deferred Linq tools hidden unless explicitly requested by the runtime", async () => {
    const { host } = await createTestHost();

    const visibleTools = new Set(
      host.getToolCatalog("orchestrator").map((tool) => tool.name),
    );
    const runtimeTools = new Set(
      host
        .getToolCatalog("orchestrator", { includeDeferred: true })
        .map((tool) => tool.name),
    );

    expect(visibleTools.has("linq_send_message")).toBe(false);
    expect(runtimeTools.has("linq_send_message")).toBe(true);
    expect(runtimeTools.has("linq_react_to_message")).toBe(true);
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

  it("executes Recall for the orchestrator and rejects other agents", async () => {
    const { host, contextLookups } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "Recall",
      {
        prompt: "Find context for what the user means by yesterday's tab.",
        memorySearchTerms: ["yesterday", "tab"],
      },
      makeToolContext("orchestrator"),
    );

    expect(orchestratorResult.error).toBeUndefined();
    expect(orchestratorResult.result).toEqual({
      status: "found",
      brief: "Relevant context for this turn.",
    });
    expect(contextLookups).toHaveLength(1);
    expect(contextLookups[0]).toMatchObject({
      conversationId: "conv-1",
      requestId: "req-1",
      runId: "run-1",
      prompt: "Find context for what the user means by yesterday's tab.",
      memorySearchTerms: ["yesterday", "tab"],
      agentType: "orchestrator",
    });

    const generalResult = await host.executeTool(
      "Recall",
      { prompt: "Find context." },
      makeToolContext("general"),
    );

    expect(generalResult.error).toContain("only available to the orchestrator");

    const missingPromptResult = await host.executeTool(
      "Recall",
      {},
      makeToolContext("orchestrator"),
    );
    expect(missingPromptResult.error).toContain("Recall prompt is required");
  });

  it("executes spawn_agent for the orchestrator and General agents and rejects the rest", async () => {
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
        modelConfigSnapshot: {
          engine: "default",
          reasoningEffort: "high",
          routeModel: "stella/openai/gpt-5.6-sol",
        },
      },
    ]);

    const generalResult = await host.executeTool(
      "spawn_agent",
      {
        description: "Delegate a slice",
        prompt: "A General agent may run its own subagents.",
      },
      makeToolContext("general"),
    );

    expect(generalResult.error).toBeUndefined();
    expect(generalResult.result).toMatchObject({
      thread_id: "thread-2",
      created: true,
      running_in_background: true,
    });

    const exploreResult = await host.executeTool(
      "spawn_agent",
      {
        description: "Should fail",
        prompt: "This agent should not have direct task creation.",
      },
      makeToolContext("explore"),
    );

    expect(exploreResult.error).toContain("only available to the orchestrator");
  });

  it("fails spawn_agent loudly when the model override cannot be routed", async () => {
    const { host, createdTasks } = await createTestHost(() => {
      throw new Error('No provider route for model "banana/split".');
    });

    const result = await host.executeTool(
      "spawn_agent",
      {
        description: "Should fail",
        prompt: "This spawn names an unroutable model.",
        model: "banana/split",
      },
      makeToolContext("orchestrator"),
    );

    expect(result.error).toBe('No provider route for model "banana/split".');
    expect(createdTasks).toEqual([]);
  });

  it("forwards per-spawn model and engine selections to createAgent", async () => {
    const { host, createdTasks } = await createTestHost(() => {});

    await host.executeTool(
      "spawn_agent",
      {
        description: "Cheap bulk pass",
        prompt: "Process the files.",
        model: "stella/light",
      },
      makeToolContext("orchestrator"),
    );
    await host.executeTool(
      "spawn_agent",
      {
        description: "Repo work",
        prompt: "Fix the bug.",
        model: "claude-code/opus",
      },
      makeToolContext("orchestrator"),
    );

    expect(createdTasks).toEqual([
      expect.objectContaining({ model: "stella/light" }),
      expect.objectContaining({
        spawnEngine: { engine: "claude_code_local", model: "opus" },
      }),
    ]);
  });
});
