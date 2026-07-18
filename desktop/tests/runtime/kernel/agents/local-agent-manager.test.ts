import { describe, expect, it, vi } from "vitest";

import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  LocalAgentManager,
  sanitizeTaskToolArgsHint,
} from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { AgentLifecycleEvent } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  createStateContext,
  handleSendInput,
} from "../../../../../runtime/kernel/tools/state.js";
import type {
  ToolContext,
  ToolResult,
} from "../../../../../runtime/kernel/tools/types.js";
import {
  __privateTaskDecorationStore,
  clearTaskDecoration,
  decorateTask,
  getTaskDecoration,
} from "@/features/chat/streaming/task-decoration-store";
import { waitForAgentSettled } from "../../../helpers/agent.js";
import { buildAgentEventPrompt } from "../../../../../runtime/kernel/runner/shared.js";
import type { PersistedAgentRecord } from "../../../../../runtime/kernel/storage/session-store.js";
import { executeAgentTurnWithRetry } from "../../../../../runtime/kernel/agent-runtime/agent-run-retry.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("task tool activity sanitization", () => {
  it("redacts environment and credential values before renderer delivery", () => {
    const hint = sanitizeTaskToolArgsHint({
      cmd: "OPENAI_API_KEY=sk-secret curl --token top-secret https://example.com?access_token=url-secret",
      env: { PUBLIC_MODE: "debug", PRIVATE_VALUE: "hidden" },
      password: "also-hidden",
    });

    expect(hint).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(hint).toContain("--token [REDACTED]");
    expect(hint).toContain("access_token=[REDACTED]");
    expect(hint).not.toContain("sk-secret");
    expect(hint).not.toContain("top-secret");
    expect(hint).not.toContain("url-secret");
    expect(hint).not.toContain("debug");
    expect(hint).not.toContain("hidden");
  });
});

describe("manager agent orchestration", () => {
  it("shows retry progress and preserves an accepted final report exactly once", async () => {
    const events: AgentLifecycleEvent[] = [];
    const reportSideEffect = vi.fn();
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      runSubagent: async (args) => {
        const retried = await executeAgentTurnWithRetry({
          execute: async (resume) => {
            if (!resume) {
              reportSideEffect();
              const report = await args.toolExecutor(
                "report",
                { message: "Durable retry-safe final report.", final: true },
                {} as ToolContext,
              );
              expect(report.error).toBeUndefined();
              return { finalText: "", errorMessage: "relay_stream_lost" };
            }
            return { finalText: "Private Manager completion text." };
          },
          prepareRetry: () => true,
          onRetry: (info) =>
            args.onStatus?.({
              statusState: "provider-retry",
              statusText: `Retrying attempt ${info.attempt} of ${info.maxAttempts}`,
            }),
          random: () => 0.5,
          sleep: async () => undefined,
        });
        return {
          runId: args.runId,
          result: retried.finalText,
          ...(retried.errorMessage ? { error: retried.errorMessage } : {}),
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => events.push(event),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-manager-retry-final",
      description: "Retry-safe Manager final",
      prompt: "Report once after transient recovery.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitForAgentSettled(manager, task.threadId);

    expect(reportSideEffect).toHaveBeenCalledOnce();
    expect(
      events.filter(
        (event) =>
          event.type === "agent-progress" &&
          event.statusText?.includes("Retrying attempt 2 of 4"),
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent-completed")).toEqual([
      expect.objectContaining({
        agentId: task.threadId,
        result: "Durable retry-safe final report.",
      }),
    ]);
    expect(events.some((event) => event.type === "agent-failed")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(
      "Private Manager completion text.",
    );
  });

  it("parks while children run, routes child completion only to the manager, and emits one consolidated result", async () => {
    const upstreamTerminalEvents: AgentLifecycleEvent[] = [];
    const managerPrompts: string[] = [];
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const manager = new LocalAgentManager({
      maxConcurrent: 3,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      runSubagent: async (args) => {
        if (args.agentType === AGENT_IDS.MANAGER) {
          managerPrompts.push(args.taskPrompt);
          if (managerPrompts.length === 1) {
            await managerFirstGate;
            return { runId: args.runId, result: "Waiting for child." };
          }
          await args.toolExecutor(
            "report",
            {
              message: "Consolidated: child passed verification.",
              final: true,
            },
            {} as ToolContext,
          );
          return {
            runId: args.runId,
            result: "Consolidated: child passed verification.",
          };
        }
        await childGate;
        return { runId: args.runId, result: "Child passed verification." };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        if (
          event.parentAgentId &&
          manager.isManagerThread(event.parentAgentId)
        ) {
          const prompt = buildAgentEventPrompt(event, { recipient: "manager" });
          if (prompt) {
            void manager.sendAgentMessage(
              event.parentAgentId,
              prompt,
              "orchestrator",
              { deliveryKind: "manager-event" },
            );
          }
          return;
        }
        if (
          event.type === "agent-completed" ||
          event.type === "agent-failed" ||
          event.type === "agent-canceled"
        ) {
          upstreamTerminalEvents.push(event);
        }
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const managerTask = await manager.createAgent({
      conversationId: "conv-manager",
      description: "Coordinate verification",
      prompt: "Coordinate verification and report once.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conv-manager",
      description: "Verify claim",
      prompt: "Verify the claim.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });

    releaseManagerFirst();
    await sleep(10);
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    releaseChild();
    await waitForAgentSettled(manager, childTask.threadId);
    await waitForAgentSettled(manager, managerTask.threadId);

    expect(managerPrompts).toHaveLength(2);
    expect(managerPrompts[1]).toContain("newly persisted managed-child event");
    expect(
      upstreamTerminalEvents.some(
        (event) => event.agentId === childTask.threadId,
      ),
    ).toBe(false);
    expect(upstreamTerminalEvents).toEqual([
      expect.objectContaining({
        type: "agent-completed",
        agentId: managerTask.threadId,
        result: "Consolidated: child passed verification.",
      }),
    ]);
  });

  it("never surfaces finalized Manager text and emits the no-final fallback", async () => {
    const events: AgentLifecycleEvent[] = [];
    let markFirstRunStarted!: () => void;
    const firstRunStarted = new Promise<void>((resolve) => {
      markFirstRunStarted = resolve;
    });
    let managerRunCount = 0;
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      runSubagent: async (args) => {
        managerRunCount += 1;
        if (managerRunCount === 1) {
          markFirstRunStarted();
          await new Promise<void>((resolve) =>
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return { runId: args.runId, result: "", interrupted: true };
        }
        return {
          runId: args.runId,
          result: "Manager final response after the child report.",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => events.push(event),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const managerTask = await manager.createAgent({
      conversationId: "conv-active-manager",
      description: "Coordinate active child reports",
      prompt: "Coordinate and report once.",
      agentType: AGENT_IDS.MANAGER,
      rootRunId: "root-active-manager",
      agentDepth: 1,
      storageMode: "local",
    });
    await firstRunStarted;
    await manager.sendAgentMessage(
      managerTask.threadId,
      "<system_reminder>A managed child reached a terminal state.</system_reminder>",
      "orchestrator",
      { deliveryKind: "manager-event" },
    );
    while (managerRunCount < 2) {
      await sleep(5);
    }

    expect(managerRunCount).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "agent-started",
      "agent-completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("A managed child");
    expect(JSON.stringify(events)).not.toContain(
      "Manager final response after the child report.",
    );
    expect(events.at(-1)).toMatchObject({
      type: "agent-completed",
      result: "Manager ended without a final report.",
    });
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "completed",
    );
  });

  it("adopts an existing thread and answers a mid-flight status poke without abandoning the work", async () => {
    const upstreamManagerMessages: string[] = [];
    const upstreamManagerResults: string[] = [];
    const managerPrompts: string[] = [];
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const manager = new LocalAgentManager({
      maxConcurrent: 3,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      runSubagent: async (args) => {
        if (args.agentType === AGENT_IDS.MANAGER) {
          managerPrompts.push(args.taskPrompt);
          if (managerPrompts.length === 1) {
            await managerFirstGate;
            return { runId: args.runId, result: "Waiting." };
          }
          if (managerPrompts.length === 2) {
            await args.toolExecutor(
              "report",
              {
                message: "Status: adopted verification is still running.",
              },
              {} as ToolContext,
            );
            return {
              runId: args.runId,
              result: "Status: adopted verification is still running.",
            };
          }
          await args.toolExecutor(
            "report",
            { message: "Final adopted-thread report.", final: true },
            {} as ToolContext,
          );
          return { runId: args.runId, result: "Final adopted-thread report." };
        }
        await childGate;
        return { runId: args.runId, result: "Adopted thread finished clean." };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        if (
          event.parentAgentId &&
          manager.isManagerThread(event.parentAgentId)
        ) {
          const prompt = buildAgentEventPrompt(event, { recipient: "manager" });
          if (prompt) {
            void manager.sendAgentMessage(
              event.parentAgentId,
              prompt,
              "orchestrator",
              { deliveryKind: "manager-event" },
            );
          }
          return;
        }
        if (
          event.type === "agent-message" &&
          event.agentType === AGENT_IDS.MANAGER
        ) {
          upstreamManagerMessages.push(event.result ?? "");
        }
        if (
          event.type === "agent-completed" &&
          event.agentType === AGENT_IDS.MANAGER
        ) {
          upstreamManagerResults.push(event.result ?? "");
        }
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const managerTask = await manager.createAgent({
      conversationId: "conv-adopt",
      description: "Own existing verification",
      prompt: "Adopt the named thread and finish the process.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const existingTask = await manager.createAgent({
      conversationId: "conv-adopt",
      description: "Existing verification",
      prompt: "Run the existing verification.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await expect(
      manager.adoptAgent(existingTask.threadId, managerTask.threadId),
    ).resolves.toEqual({ adopted: true });

    releaseManagerFirst();
    await sleep(10);
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Give me a status update, then continue.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    while (upstreamManagerMessages.length < 1) {
      await sleep(5);
    }
    expect(upstreamManagerMessages).toEqual([
      "Status: adopted verification is still running.",
    ]);
    expect(upstreamManagerResults).toEqual([]);

    releaseChild();
    await waitForAgentSettled(manager, existingTask.threadId);
    await waitForAgentSettled(manager, managerTask.threadId);
    expect(managerPrompts[2]).toContain("newly persisted managed-child event");
    expect(upstreamManagerResults).toEqual(["Final adopted-thread report."]);
  });

  it("delivers an accepted final report exactly once across attempt fencing", async () => {
    const events: AgentLifecycleEvent[] = [];
    let finalAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      finalAccepted = resolve;
    });
    let runCount = 0;
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          const submitted = await args.toolExecutor(
            "report",
            { message: "Durable fenced final report.", final: true },
            {} as ToolContext,
          );
          expect(submitted.error).toBeUndefined();
          finalAccepted();
          await new Promise<void>((resolve) =>
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return {
            runId: args.runId,
            result: "Private stale finalized turn.",
            interrupted: true,
          };
        }
        const duplicate = await args.toolExecutor(
          "report",
          { message: "Duplicate final report.", final: true },
          {} as ToolContext,
        );
        expect(duplicate.error).toMatch(/already accepted/i);
        return {
          runId: args.runId,
          result: "Private replacement finalized turn.",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => events.push(event),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-fenced-report",
      description: "Fence final Manager report",
      prompt: "Report once, then finish.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await accepted;
    await manager.sendAgentMessage(
      task.threadId,
      "Retry the interrupted completion.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitForAgentSettled(manager, task.threadId);

    expect(runCount).toBe(2);
    expect(
      events.filter(
        (event) =>
          event.type === "agent-completed" && event.agentId === task.threadId,
      ),
    ).toEqual([
      expect.objectContaining({
        result: "Durable fenced final report.",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("Private stale finalized");
    expect(JSON.stringify(events)).not.toContain(
      "Private replacement finalized",
    );
    expect(JSON.stringify(events)).not.toContain("Duplicate final report");
  });

  it("recovers a normal Manager completion exactly once when its row write crashes", async () => {
    const records = new Map<string, PersistedAgentRecord>();
    const durableLifecycleEvents = new Set<string>();
    const lifecycleEvents: AgentLifecycleEvent[] = [];
    let failNextCompletedSave = true;
    let markCompletedSaveFailed!: () => void;
    const completedSaveFailed = new Promise<void>((resolve) => {
      markCompletedSaveFailed = resolve;
    });
    const options: ConstructorParameters<typeof LocalAgentManager>[0] = {
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      runSubagent: async (args) => {
        const submitted = await args.toolExecutor(
          "report",
          { message: "Crash-safe normal final.", final: true },
          {} as ToolContext,
        );
        expect(submitted.error).toBeUndefined();
        return {
          runId: args.runId,
          result: "Private finalized Manager text.",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      getAgentRecord: (threadId) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status) =>
        [...records.values()].filter((record) => record.status === status),
      saveAgentRecord: (record) => {
        if (record.status === "completed" && failNextCompletedSave) {
          failNextCompletedSave = false;
          expect(
            durableLifecycleEvents.has(
              `${record.threadId}:${record.attemptGeneration}:agent-completed`,
            ),
          ).toBe(true);
          markCompletedSaveFailed();
          throw new Error("Injected crash after normal completion append");
        }
        records.set(record.threadId, { ...record });
      },
      hasAgentLifecycleEvent: (_conversationId, eventId) =>
        durableLifecycleEvents.has(eventId),
      onAgentEvent: (event) => {
        lifecycleEvents.push(event);
        if (event.eventId) durableLifecycleEvents.add(event.eventId);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    };
    const manager = new LocalAgentManager(options);

    const task = await manager.createAgent({
      conversationId: "conv-normal-completion-crash",
      description: "Crash-safe normal completion",
      prompt: "Submit one final report.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await completedSaveFailed;

    expect(records.get(task.threadId)).toMatchObject({
      status: "running",
      managerReportState: { finalMessage: "Crash-safe normal final." },
    });
    new LocalAgentManager(options);
    new LocalAgentManager(options);

    expect(records.get(task.threadId)).toMatchObject({
      status: "completed",
      result: "Crash-safe normal final.",
    });
    expect(
      lifecycleEvents.filter(
        (event) =>
          event.type === "agent-completed" && event.agentId === task.threadId,
      ),
    ).toEqual([
      expect.objectContaining({
        eventId: `${task.threadId}:1:agent-completed`,
        result: "Crash-safe normal final.",
      }),
    ]);
    expect(JSON.stringify(lifecycleEvents)).not.toContain(
      "Private finalized Manager text.",
    );
  });

  it("seals descendants and preserves an accepted final if a child appears after acceptance", async () => {
    const events: AgentLifecycleEvent[] = [];
    const savedRecords: PersistedAgentRecord[] = [];
    let racingChildActive = false;
    let managerThreadId = "";
    let runCount = 0;
    const racingChild: PersistedAgentRecord = {
      threadId: "racing-child-after-final",
      conversationId: "conv-final-child-race",
      agentType: AGENT_IDS.GENERAL,
      description: "Racing child",
      agentDepth: 2,
      parentAgentId: "pending-manager-id",
      status: "running",
      attemptGeneration: 0,
      startedAt: 10,
      completedAt: null,
      updatedAt: 10,
    };
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          const submitted = await args.toolExecutor(
            "report",
            { message: "Sealed report survives the child race.", final: true },
            {} as ToolContext,
          );
          expect(submitted.error).toBeUndefined();
          racingChild.parentAgentId = managerThreadId;
          racingChildActive = true;
          return {
            runId: args.runId,
            result: "Private turn before racing child wait.",
          };
        }
        return {
          runId: args.runId,
          result: "Private turn after racing child settled.",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      getAgentRecord: (threadId) =>
        threadId === racingChild.threadId ? racingChild : null,
      listAgentRecordsByStatus: (status) =>
        status === "running" && racingChildActive ? [racingChild] : [],
      saveAgentRecord: (record) => savedRecords.push({ ...record }),
      onAgentEvent: (event) => events.push(event),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-final-child-race",
      description: "Protect accepted final report",
      prompt: "Submit the final report once.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    managerThreadId = task.threadId;

    while (
      savedRecords.filter(
        (record) =>
          record.managerReportState?.finalMessage ===
          "Sealed report survives the child race.",
      ).length < 2
    ) {
      await sleep(5);
    }
    await expect(
      manager.createAgent({
        conversationId: "conv-final-child-race",
        description: "Late child",
        prompt: "This child must not start.",
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 2,
        parentAgentId: task.threadId,
        storageMode: "local",
      }),
    ).rejects.toThrow(/already submitted its final report/i);

    expect((await manager.getAgent(task.threadId))?.status).toBe("running");
    expect(savedRecords.at(-1)?.managerReportState).toMatchObject({
      finalMessage: "Sealed report survives the child race.",
    });

    racingChildActive = false;
    await manager.sendAgentMessage(
      task.threadId,
      "<system_reminder>The racing child settled.</system_reminder>",
      "orchestrator",
      { deliveryKind: "manager-event" },
    );
    await waitForAgentSettled(manager, task.threadId);

    expect(runCount).toBe(2);
    expect(
      events.filter(
        (event) =>
          event.type === "agent-completed" && event.agentId === task.threadId,
      ),
    ).toEqual([
      expect.objectContaining({
        result: "Sealed report survives the child race.",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("Private turn before");
    expect(JSON.stringify(events)).not.toContain("Private turn after");
  });
});

describe("LocalAgentManager Exec fs locking", () => {
  it("cancels persisted running agents left behind by a previous worker", () => {
    const savedRecords: Parameters<
      NonNullable<
        ConstructorParameters<typeof LocalAgentManager>[0]["saveAgentRecord"]
      >
    >[0][] = [];
    const lifecycleEvents: AgentLifecycleEvent[] = [];

    new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "unused",
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      listAgentRecordsByStatus: (status) =>
        status === "running"
          ? [
              {
                threadId: "task-8",
                conversationId: "conv-1",
                agentType: "general",
                description: "stale agent task",
                agentDepth: 0,
                status: "running",
                startedAt: 123,
                completedAt: null,
                updatedAt: 456,
              },
              {
                threadId: "task-9",
                conversationId: "conv-1",
                agentType: "general",
                description: "second stale agent task",
                agentDepth: 0,
                status: "running",
                startedAt: 234,
                completedAt: null,
                updatedAt: 567,
              },
            ]
          : [],
      saveAgentRecord: (record) => {
        savedRecords.push(record);
      },
      onAgentEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    expect(savedRecords).toHaveLength(2);
    expect(savedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "task-8",
          status: "canceled",
          completedAt: expect.any(Number),
          error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        }),
        expect.objectContaining({
          threadId: "task-9",
          status: "canceled",
          completedAt: expect.any(Number),
          error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        }),
      ]),
    );
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        type: "agent-canceled",
        conversationId: "conv-1",
        agentId: "task-8",
        error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        audience: "display-only",
      }),
      expect.objectContaining({
        type: "agent-canceled",
        conversationId: "conv-1",
        agentId: "task-9",
        error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        audience: "display-only",
      }),
    ]);
  });

  it("recovers a persisted Manager final exactly once after worker restart", () => {
    const records = new Map<string, PersistedAgentRecord>();
    records.set("persisted-manager-final", {
      threadId: "persisted-manager-final",
      conversationId: "conv-persisted-manager-final",
      rootRunId: "root-persisted-manager-final",
      agentType: AGENT_IDS.MANAGER,
      description: "Persisted Manager final",
      agentDepth: 1,
      managerReportState: {
        reportSequence: 0,
        finalMessage: "Recovered durable final report.",
        finalAttemptGeneration: 7,
      },
      status: "running",
      attemptGeneration: 7,
      startedAt: 100,
      completedAt: null,
      updatedAt: 200,
    });
    const lifecycleEvents: AgentLifecycleEvent[] = [];
    const durableLifecycleEvents = new Set<string>();
    let failNextCompletedSave = true;
    const makeManager = () =>
      new LocalAgentManager({
        maxConcurrent: 1,
        fetchAgentContext: async () => ({
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 2,
        }),
        runSubagent: async (args) => ({
          runId: args.runId,
          result: "unused",
        }),
        toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
        listAgentRecordsByStatus: (status) =>
          [...records.values()].filter((record) => record.status === status),
        saveAgentRecord: (record) => {
          if (record.status === "completed" && failNextCompletedSave) {
            failNextCompletedSave = false;
            expect(
              durableLifecycleEvents.has(
                `${record.threadId}:${record.attemptGeneration}:agent-completed`,
              ),
            ).toBe(true);
            throw new Error("Injected crash before completed row write");
          }
          records.set(record.threadId, { ...record });
        },
        hasAgentLifecycleEvent: (_conversationId, eventId) =>
          durableLifecycleEvents.has(eventId),
        onAgentEvent: (event) => {
          lifecycleEvents.push(event);
          if (event.eventId) durableLifecycleEvents.add(event.eventId);
        },
        createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
        completeCloudAgentRecord: async () => undefined,
        getCloudAgentRecord: async () => null,
        cancelCloudAgentRecord: async () => ({ canceled: false }),
      });

    expect(() => makeManager()).toThrow(
      "Injected crash before completed row write",
    );
    expect(records.get("persisted-manager-final")?.status).toBe("running");
    makeManager();
    makeManager();

    expect(records.get("persisted-manager-final")).toMatchObject({
      status: "completed",
      completedAt: expect.any(Number),
      result: "Recovered durable final report.",
      managerReportState: {
        finalMessage: "Recovered durable final report.",
        finalAttemptGeneration: 7,
      },
    });
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        type: "agent-completed",
        eventId: "persisted-manager-final:7:agent-completed",
        conversationId: "conv-persisted-manager-final",
        rootRunId: "root-persisted-manager-final",
        agentId: "persisted-manager-final",
        attemptGeneration: 7,
        result: "Recovered durable final report.",
      }),
    ]);
    expect(JSON.stringify(lifecycleEvents)).not.toContain(
      AGENT_ORPHANED_RESTART_CANCEL_REASON,
    );
  });

  it("emits completed terminal events with the agent result and file changes", async () => {
    const events: AgentLifecycleEvent[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "Agent finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/agent-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "agent task",
      prompt: "do agent work",
      agentType: "general",
      storageMode: "local",
    });

    await waitForAgentSettled(manager, task.threadId);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent-completed",
        conversationId: "conv-1",
        agentId: task.threadId,
        agentType: "general",
        description: "agent task",
        result: "Agent finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/agent-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
    );
  });

  it("threads per-spawn model and engine selections into the agent context fetch", async () => {
    const contextFetches: Array<Record<string, unknown>> = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async (args) => {
        contextFetches.push({
          agentType: args.agentType,
          model: args.model,
          spawnEngine: args.spawnEngine,
          spawnReasoningEffort: args.spawnReasoningEffort,
        });
        return {
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 3,
        };
      },
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "done",
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const modelTask = await manager.createAgent({
      conversationId: "conv-1",
      description: "cheap task",
      prompt: "do work",
      agentType: "general",
      model: "stella/light",
      spawnEngine: { engine: "default" },
      spawnReasoningEffort: "high",
      storageMode: "local",
    });
    await waitForAgentSettled(manager, modelTask.threadId);

    const engineTask = await manager.createAgent({
      conversationId: "conv-1",
      description: "cc task",
      prompt: "do work",
      agentType: "general",
      spawnEngine: { engine: "claude_code_local", model: "opus" },
      storageMode: "local",
    });
    await waitForAgentSettled(manager, engineTask.threadId);

    expect(contextFetches).toEqual([
      {
        agentType: "general",
        model: "stella/light",
        spawnEngine: { engine: "default" },
        spawnReasoningEffort: "high",
      },
      {
        agentType: "general",
        model: undefined,
        spawnEngine: { engine: "claude_code_local", model: "opus" },
        spawnReasoningEffort: undefined,
      },
    ]);
  });

  it("exposes active background agent root runs", async () => {
    let releaseRun: (() => void) | null = null;
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        await running;
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "background task",
      prompt: "do work",
      agentType: "general",
      rootRunId: "root-run-1",
      storageMode: "local",
    });

    expect(manager.listActiveAgentRuns()).toEqual([
      { runId: "root-run-1", conversationId: "conv-1" },
    ]);

    releaseRun?.();
    await waitForAgentSettled(manager, task.threadId);
    expect(manager.listActiveAgentRuns()).toEqual([]);
  });

  it("routes send_input task lifecycle through the current root run and clears composer chip state on completion", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let secondRunStarted: (() => void) | null = null;
    const secondRunStartedPromise = new Promise<void>((resolve) => {
      secondRunStarted = resolve;
    });
    let finishSecondRun: (() => void) | null = null;
    const finishSecondRunPromise = new Promise<void>((resolve) => {
      finishSecondRun = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 2) {
          secondRunStarted?.();
          await finishSecondRunPromise;
        }
        return {
          runId: args.runId,
          result: `done-${runCount}`,
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "Research current Nvidia news",
      prompt: "Research current Nvidia news",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-original",
      storageMode: "local",
    });
    await waitForAgentSettled(manager, task.threadId);

    const eventOffset = events.length;
    const toolContext = createStateContext("/tmp", {
      createAgent: async (request) => manager.createAgent(request),
      getAgent: async (threadId) => manager.getAgent(threadId),
      cancelAgent: async (threadId, reason) =>
        manager.cancelAgent(threadId, reason),
      sendAgentMessage: async (threadId, message, from, options) =>
        manager.sendAgentMessage(threadId, message, from, options),
    });

    await expect(
      handleSendInput(
        toolContext,
        {
          thread_id: task.threadId,
          message: "resume the web research with the new requirement",
          description: "Resume current Nvidia web research",
        },
        {
          conversationId: "conv-1",
          deviceId: "device-1",
          requestId: "request-2",
          rootRunId: "root-current",
          agentType: AGENT_IDS.ORCHESTRATOR,
        },
      ),
    ).resolves.toMatchObject({
      result: {
        thread_id: task.threadId,
        status: "updated",
        delivered: true,
      },
    });

    await secondRunStartedPromise;
    expect(manager.listActiveAgentRuns()).toEqual([
      { runId: "root-current", conversationId: "conv-1" },
    ]);

    finishSecondRun?.();
    await waitForAgentSettled(manager, task.threadId);

    // The initial spawn's agent-started is NOT flagged a follow-up.
    const spawnStarted = events
      .slice(0, eventOffset)
      .find(
        (event) =>
          event.type === "agent-started" && event.agentId === task.threadId,
      );
    expect(spawnStarted).toBeDefined();
    expect(spawnStarted?.isFollowUp).toBeUndefined();
    expect(spawnStarted?.attemptGeneration).toBe(1);

    const resumedEvents = events.slice(eventOffset);
    // The send_input re-activation IS explicitly flagged a follow-up, and
    // carries the follow-up's own message on `statusText`.
    expect(resumedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent-started",
          rootRunId: "root-current",
          agentId: task.threadId,
          statusText: "Resume current Nvidia web research",
          isFollowUp: true,
          attemptGeneration: expect.any(Number),
        }),
        expect.objectContaining({
          type: "agent-completed",
          rootRunId: "root-current",
          agentId: task.threadId,
          result: "done-2",
        }),
      ]),
    );
    expect(
      resumedEvents.every((event) => event.rootRunId === "root-current"),
    ).toBe(true);
    const resumedStart = resumedEvents.find(
      (event) => event.type === "agent-started",
    );
    const resumedTerminal = resumedEvents.find(
      (event) => event.type === "agent-completed",
    );
    expect(resumedStart?.attemptGeneration).toBeGreaterThan(
      spawnStarted?.attemptGeneration ?? 0,
    );
    expect(resumedTerminal?.attemptGeneration).toBe(
      resumedStart?.attemptGeneration,
    );

    // Renderer side: the follow-up's stream events maintain only the
    // ephemeral decoration (keyed by thread, rebound to the current run),
    // and the completion clears it — no per-run task copies to leak.
    for (const event of resumedEvents) {
      if (!event.agentId) continue;
      if (event.type === "agent-completed") {
        clearTaskDecoration(event.agentId);
        continue;
      }
      decorateTask({
        agentId: event.agentId,
        conversationId: "conv-1",
        runId: event.rootRunId,
        statusText: event.statusText,
      });
      expect(getTaskDecoration(event.agentId)?.runId).toBe("root-current");
    }
    // Completion left no lingering decoration behind.
    expect(getTaskDecoration(task.threadId)).toBeUndefined();
    __privateTaskDecorationStore.resetForTests();
  });

  it("emits an interjected turn's real finish immediately — no deferral, no audience split", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            if (args.abortSignal.aborted) {
              resolve();
              return;
            }
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { runId: args.runId, result: "", interrupted: true };
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "long research task",
      prompt: "do long research",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    // User message relayed mid-task: hard-cut interjection. The follow-up
    // turn runs, and when it finishes the thread is idle with no pending
    // follow-up — that IS the real finish, so the full completion (chat
    // card included) emits immediately. State-based rule: no grace timer,
    // no orchestrator-only/display-only split.
    await manager.sendAgentMessage(
      task.threadId,
      "how is it going?",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(1);

    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ result: "done-2" });
    expect(completions()[0]?.audience).toBeUndefined();
    // Fully finished — nothing pending keeps the thread "active".
    expect(manager.getActiveAgentCount()).toBe(0);

    // Orchestrator resumes the now-idle thread: that's a NEW run with its
    // own completion card at its own completion. Done → running-again is
    // honest history, not a glitch to suppress.
    await manager.sendAgentMessage(
      task.threadId,
      "continue the task",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(2);

    expect(completions()).toHaveLength(2);
    expect(completions()[1]).toMatchObject({ result: "done-3" });
    expect(completions()[1]?.audience).toBeUndefined();
    expect(
      events.every(
        (event) =>
          event.audience !== "display-only" &&
          event.audience !== "orchestrator-only",
      ),
    ).toBe(true);
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it("classifies a send_input racing turn completion atomically: pre-dispatch = busy, no boundary card", async () => {
    // The dangerous window: `runSubagent` has resolved but the completion
    // dispatch hasn't run yet. A send_input landing there sees the task
    // still "running" and queues a follow-up; the dispatch then
    // short-circuits into the follow-up delivery WITHOUT emitting a
    // completion for that internal boundary. Exactly one completion — the
    // continued turn's real finish — ever emits. (Single-threaded state:
    // there is no await between runSubagent resolving and the emit, so the
    // classification can never straddle the boundary.)
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          // Hold the turn open until the racing send_input has been
          // classified, then complete NORMALLY (ignore the abort signal —
          // models the turn finishing at the same instant the input
          // arrives).
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          return { runId: args.runId, result: "done-1" };
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "racy task",
      prompt: "do the work",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    // send_input while the turn is still in flight → busy classification
    // (queued follow-up), even though the turn completes immediately after.
    await manager.sendAgentMessage(
      task.threadId,
      "one more thing",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    releaseFirstRun?.();

    await waitForCompletions(1);
    // Exactly one completion: the continued turn's. The interjected
    // boundary (done-1) never emitted a completion/card.
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ result: "done-2" });
    expect(completions()[0]?.audience).toBeUndefined();
    expect(completions().every((event) => event.result !== "done-1")).toBe(
      true,
    );
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it("emits failed terminal events when an engine turn throws", async () => {
    const events: AgentLifecycleEvent[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async () => {
        throw new Error("engine transport failed");
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "broken engine task",
      prompt: "do work",
      agentType: "general",
      storageMode: "local",
    });

    await waitForAgentSettled(manager, task.threadId);

    await expect(manager.getAgent(task.threadId)).resolves.toMatchObject({
      status: "error",
      error: "engine transport failed",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent-failed",
        conversationId: "conv-1",
        agentId: task.threadId,
        agentType: "general",
        error: "engine transport failed",
      }),
    );
  });

  it("serializes mutating Exec calls across concurrent tasks", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        const toolContext: ToolContext = {
          conversationId: args.conversationId,
          deviceId: "device-1",
          requestId: `${args.runId}-req`,
          agentType: args.agentType,
          storageMode: "local",
        };
        await args.toolExecutor(
          "Exec",
          {
            summary: "mutate files",
            source: `await tools.apply_patch({ patch: "*** Begin Patch\\n*** End Patch\\n" });`,
          },
          toolContext,
          args.abortSignal,
        );
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (
        toolName: string,
        _args: Record<string, unknown>,
        _context: ToolContext,
      ): Promise<ToolResult> => {
        expect(toolName).toBe("Exec");
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        try {
          await sleep(75);
        } finally {
          activeCalls -= 1;
        }
        return { result: "ok" };
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    await expect(manager.getAgent(first.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(manager.getAgent(second.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(maxConcurrentCalls).toBe(1);
  });

  it("allows concurrent Codex engine runs", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "codex_cli",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(2);
  });

  it("allows concurrent General Codex engine runs", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "codex_cli",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(2);
  });
});

describe("LocalAgentManager file records across send_input re-runs", () => {
  it("banks a send_input-interrupted run's files into the eventual completion rollup, then drains", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            if (args.abortSignal.aborted) {
              resolve();
              return;
            }
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          // The interrupted run DID produce real files (e.g. rendered
          // videos in ~/.stella/outputs) before the send_input cut it off.
          return {
            runId: args.runId,
            result: "",
            interrupted: true,
            fileChanges: [
              {
                path: "/home/u/.stella/outputs/demos/review.html",
                kind: { type: "update" as const },
              },
            ],
            producedFiles: [
              {
                path: "/home/u/.stella/outputs/demos/demo1.mp4",
                kind: { type: "add" as const },
              },
            ],
          };
        }
        if (runCount === 2) {
          // Follow-up run re-reports one banked write (dedupe) and adds a
          // new one.
          return {
            runId: args.runId,
            result: `done-${runCount}`,
            producedFiles: [
              {
                path: "/home/u/.stella/outputs/demos/demo1.mp4",
                kind: { type: "add" as const },
              },
              {
                path: "/home/u/.stella/outputs/demos/demo2.mp4",
                kind: { type: "add" as const },
              },
            ],
          };
        }
        // Post-drain run: only its own new file.
        return {
          runId: args.runId,
          result: `done-${runCount}`,
          producedFiles: [
            {
              path: "/home/u/.stella/outputs/demos/final.pdf",
              kind: { type: "add" as const },
            },
          ],
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "render demo videos",
      prompt: "render the demos",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    // send_input mid-run: aborts run 1 (its completion is never emitted)
    // and delivers the follow-up as the next turn on the same session.
    await manager.sendAgentMessage(
      task.threadId,
      "add music to the videos",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(1);

    // The first EMITTED completion must carry run 1's banked files merged
    // with run 2's, deduped by path+kind.
    const first = completions()[0]!;
    expect(first.fileChanges).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/review.html",
        kind: { type: "update" },
      },
    ]);
    expect(first.producedFiles).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/demo1.mp4",
        kind: { type: "add" },
      },
      {
        path: "/home/u/.stella/outputs/demos/demo2.mp4",
        kind: { type: "add" },
      },
    ]);

    // Resume the now-idle thread: the bank was drained when the first
    // completion emitted, so the resumed run's own completion only reveals
    // the new run's files (append-only property). No audience-split
    // duplicates exist under the state-based completion rule.
    await manager.sendAgentMessage(
      task.threadId,
      "export a final pdf",
      "orchestrator",
      { rootRunId: "root-3" },
    );
    await waitForCompletions(2);

    expect(completions()).toHaveLength(2);
    const second = completions()[1]!;
    expect(second.audience).toBeUndefined();
    expect(second.result).toBe("done-3");
    expect(second.fileChanges).toBeUndefined();
    expect(second.producedFiles).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/final.pdf",
        kind: { type: "add" },
      },
    ]);
  });

  it("advances snapshot lastActivityAt on tool lifecycle during one long tool call", async () => {
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let toolStarted: (() => void) | undefined;
    const toolStartedPromise = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      // Simulates a run whose only activity is one slow tool: no streamed
      // progress (onProgress never fires), just a tool_start then a long wait.
      runSubagent: async (args) => {
        args.onToolStart?.({
          runId: args.runId,
          seq: 1,
          toolCallId: "call-1",
          toolName: "exec_command",
          statusText: "Running exec_command",
        });
        toolStarted?.();
        await runGate;
        args.onToolEnd?.({
          runId: args.runId,
          seq: 2,
          toolCallId: "call-1",
          toolName: "exec_command",
          resultPreview: "ok",
        });
        return { runId: args.runId, result: "done" };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const beforeCreate = Date.now();
    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "slow connector probe",
      prompt: "probe the connector",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await toolStartedPromise;

    const midToolSnapshot = await manager.getAgent(task.threadId);
    expect(midToolSnapshot?.status).toBe("running");
    // Tool start stamped liveness and marked the tool in flight.
    expect(midToolSnapshot?.lastActivityAt).toBeGreaterThanOrEqual(
      beforeCreate,
    );
    expect(midToolSnapshot?.activeToolCount).toBe(1);
    expect(midToolSnapshot?.recentActivity).toEqual(["Running exec_command"]);

    // Real manager behavior while the tool keeps running: the stamp does
    // NOT move (nothing re-stamps it mid-call) — `activeToolCount` is the
    // only signal that the agent isn't idle. This is exactly the window
    // where a stamp-only idle test would wrongly cancel.
    const stampAfterStart = midToolSnapshot?.lastActivityAt ?? 0;
    await sleep(30);
    const stillMidToolSnapshot = await manager.getAgent(task.threadId);
    expect(stillMidToolSnapshot?.lastActivityAt).toBe(stampAfterStart);
    expect(stillMidToolSnapshot?.activeToolCount).toBe(1);

    releaseRun?.();
    await waitForAgentSettled(manager, task.threadId);

    const finalSnapshot = await manager.getAgent(task.threadId);
    expect(finalSnapshot?.status).toBe("completed");
    // Tool end bumped the stamp past the tool-start one and cleared the
    // in-flight count.
    expect(finalSnapshot?.lastActivityAt).toBeGreaterThan(stampAfterStart);
    expect(finalSnapshot?.activeToolCount).toBe(0);
  });
});

describe("send_input follow-up description and run rebind", () => {
  it.each([
    [AGENT_IDS.GENERAL, "completed"],
    [AGENT_IDS.GENERAL, "canceled"],
    [AGENT_IDS.MANAGER, "completed"],
    [AGENT_IDS.MANAGER, "canceled"],
  ] as const)(
    "persists a resumed %s %s thread as running immediately and settles it",
    async (agentType, terminalStatus) => {
      const threadId = `${agentType}-${terminalStatus}-resume`;
      const persisted: PersistedAgentRecord = {
        threadId,
        conversationId: "conv-resume-activity",
        agentType,
        description: "Original work",
        agentDepth: agentType === AGENT_IDS.MANAGER ? 1 : 2,
        ...(agentType === AGENT_IDS.MANAGER
          ? {
              managerReportState: {
                reportSequence: 1,
                finalMessage: "Already delivered final report.",
                finalAttemptGeneration: 3,
              },
            }
          : {}),
        status: terminalStatus,
        attemptGeneration: 3,
        startedAt: 100,
        completedAt: 200,
        updatedAt: 200,
      };
      const saved: PersistedAgentRecord[] = [];
      const events: AgentLifecycleEvent[] = [];
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const manager = new LocalAgentManager({
        maxConcurrent: 1,
        fetchAgentContext: async () => ({
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 4,
        }),
        runSubagent: async (args) => {
          markStarted();
          await gate;
          return { runId: args.runId, result: "Resumed parent reply" };
        },
        toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
        getAgentRecord: (candidate) =>
          candidate === threadId ? persisted : null,
        saveAgentRecord: (record) => saved.push({ ...record }),
        onAgentEvent: (event) => events.push(event),
        resolveTaskThread: () => ({
          threadId,
          conversationId: persisted.conversationId,
          agentType,
          name: "Resumed thread",
          createdAt: 100,
          lastUsedAt: 200,
        }),
        createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
        completeCloudAgentRecord: async () => undefined,
        getCloudAgentRecord: async () => null,
        cancelCloudAgentRecord: async () => ({ canceled: false }),
      });

      await expect(
        manager.sendAgentMessage(
          threadId,
          "Apply the resumed requirement",
          "orchestrator",
          { deliveryKind: "external-input", rootRunId: "root-resumed" },
        ),
      ).resolves.toEqual({ delivered: true });
      await started;

      expect(saved.at(-1)).toMatchObject({
        threadId,
        status: "running",
        attemptGeneration: 4,
        rootRunId: "root-resumed",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent-started",
          agentId: threadId,
          isFollowUp: true,
          attemptGeneration: 4,
        }),
      );

      finish();
      if (agentType === AGENT_IDS.MANAGER) {
        await waitForAgentSettled(manager, threadId);
        expect(saved.at(-1)).toMatchObject({
          threadId,
          status: "completed",
          attemptGeneration: 4,
          result: "Manager ended without a final report.",
        });
        expect(saved.at(-1)?.result).not.toBe(
          "Already delivered final report.",
        );
        return;
      }
      await waitForAgentSettled(manager, threadId);
      expect(saved.at(-1)).toMatchObject({
        threadId,
        status: "completed",
        attemptGeneration: 4,
        result: "Resumed parent reply",
      });
    },
  );

  it("adopts the orchestrator follow-up description onto the thread", async () => {
    // The folded Activity row is keyed per thread and titled by
    // `description`. A follow-up re-tasks the thread, so every lifecycle
    // event after the send_input must carry the follow-up's description —
    // not the original spawn text frozen forever.
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            if (args.abortSignal.aborted) {
              resolve();
              return;
            }
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { runId: args.runId, result: "", interrupted: true };
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "find the booked itinerary",
      prompt: "find the booked itinerary",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    await manager.sendAgentMessage(
      task.threadId,
      "search specifically for the forwarded itinerary email",
      "orchestrator",
      {
        description: "search for the itinerary email",
        rootRunId: "root-2",
      },
    );
    await waitForAgentSettled(manager, task.threadId);

    const followUpStarted = events.find(
      (event) => event.type === "agent-started" && event.isFollowUp,
    );
    expect(followUpStarted).toMatchObject({
      rootRunId: "root-2",
      description: "search for the itinerary email",
    });
    const completion = events.find((event) => event.type === "agent-completed");
    expect(completion).toMatchObject({
      rootRunId: "root-2",
      description: "search for the itinerary email",
    });
    // The updated description sticks on the thread snapshot too.
    const snapshot = await manager.getAgent(task.threadId);
    expect(snapshot?.description).toBe("search for the itinerary email");
  });

  it("rebinds a thread's decoration to the follow-up's run without leaking per-run copies", () => {
    // The old per-run task store leaked a frozen "running" copy under the
    // spawn run when send_input rebound a thread to the caller's run —
    // that copy pinned the Activity row open forever. Decorations are
    // keyed by thread: a rebind is an in-place update, and the terminal
    // stream event clears it. Authoritative status lives in the
    // thread-activity rows and never depends on this map.
    decorateTask({
      agentId: "thread-1",
      conversationId: "conv-1",
      runId: "root-1",
      statusText: "find the booked itinerary",
    });
    expect(getTaskDecoration("thread-1")?.runId).toBe("root-1");

    // Follow-up streams under the new run: same single entry, new runId.
    decorateTask({
      agentId: "thread-1",
      conversationId: "conv-1",
      runId: "root-2",
      statusText: "search for the itinerary email",
    });
    expect(getTaskDecoration("thread-1")).toMatchObject({
      runId: "root-2",
      statusText: "search for the itinerary email",
    });

    clearTaskDecoration("thread-1");
    expect(getTaskDecoration("thread-1")).toBeUndefined();
    __privateTaskDecorationStore.resetForTests();
  });
});
