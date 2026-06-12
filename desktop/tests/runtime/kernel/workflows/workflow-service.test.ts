import crypto from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLifecycleEvent } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import { WorkflowScriptSyntaxError } from "../../../../../runtime/kernel/workflows/script-runtime.js";
import {
  WORKFLOW_MAX_AGENT_CALLS,
  WorkflowService,
  type WorkflowEphemeralAgentRunner,
} from "../../../../../runtime/kernel/workflows/workflow-service.js";

type RunAgentArgs = Parameters<WorkflowEphemeralAgentRunner>[0];
type RunAgentOutcome = Awaited<ReturnType<WorkflowEphemeralAgentRunner>>;

type Harness = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
  events: AgentLifecycleEvent[];
  runAgent: ReturnType<typeof vi.fn<WorkflowEphemeralAgentRunner>>;
  service: WorkflowService;
};

type StepRow = {
  workflow_key: string;
  step_index: number;
  label: string;
  prompt_hash: string;
  status: string;
  result_json: string | null;
  error: string | null;
  started_at: number;
  completed_at: number | null;
};

const harnesses: Harness[] = [];

const createHarness = (
  runAgentImpl?: (args: RunAgentArgs) => Promise<RunAgentOutcome>,
): Harness => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-workflow-service-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const store = new SessionStore(db);
  const events: AgentLifecycleEvent[] = [];
  const runAgent = vi.fn<WorkflowEphemeralAgentRunner>(
    runAgentImpl ?? (async () => ({ result: "ok" })),
  );
  const service = new WorkflowService({
    store,
    runAgent,
    emitLifecycleEvent: (event) => {
      events.push(event);
    },
  });
  const harness = { rootPath, db, store, events, runAgent, service };
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  for (const harness of harnesses) {
    harness.service.shutdown();
  }
  // Let any just-aborted scripts finalize before the database closes.
  await new Promise((resolve) => setTimeout(resolve, 25));
  for (const harness of harnesses) {
    try {
      harness.db.close();
    } catch {
      // already closed
    }
    await rm(harness.rootPath, { recursive: true, force: true });
  }
  harnesses.length = 0;
});

const waitForWorkflowStatus = (
  harness: Harness,
  workflowKey: string,
  status: string,
  timeout = 5_000,
) =>
  vi.waitFor(
    () => {
      expect(harness.store.getWorkflowRecord(workflowKey)?.status).toBe(status);
    },
    { timeout, interval: 10 },
  );

const stepRows = (harness: Harness, workflowKey: string): StepRow[] =>
  harness.db
    .prepare(
      "SELECT * FROM runtime_workflow_steps WHERE workflow_key = ? ORDER BY step_index",
    )
    .all(workflowKey) as StepRow[];

/** A runAgent fake that hangs until its signal aborts, then rejects. */
const hangUntilAborted: WorkflowEphemeralAgentRunner = ({ signal }) =>
  new Promise((_, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

const COUNT_SCHEMA = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
  additionalProperties: false,
};

describe("WorkflowService.startWorkflow", () => {
  it("throws WorkflowScriptSyntaxError on bad syntax before creating any rows", async () => {
    const harness = createHarness();
    await expect(
      harness.service.startWorkflow({
        conversationId: "conv-1",
        description: "Bad script",
        script: "const = ;",
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptSyntaxError);

    const threadCount = harness.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_threads")
      .get() as { count: number };
    const workflowCount = harness.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_workflows")
      .get() as { count: number };
    expect(threadCount.count).toBe(0);
    expect(workflowCount.count).toBe(0);
    expect(harness.events).toHaveLength(0);
  });

  it("runs a script to completion: thread row, workflow record, agent record, lifecycle events", async () => {
    const harness = createHarness();
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Summarize inbox digest",
      script: 'log("Working on the digest");\nreturn "all done";',
    });
    expect(workflowId).toBe("summarize-inbox-digest");
    await waitForWorkflowStatus(harness, workflowId, "completed");

    // Thread row: agent_type 'workflow', name = description, discoverable.
    const thread = harness.store
      .listActiveThreads("conv-1")
      .find((entry) => entry.threadId === workflowId);
    expect(thread?.agentType).toBe("workflow");
    expect(thread?.name).toBe("Summarize inbox digest");
    expect(
      harness.store
        .searchThreads({ conversationId: "conv-1", query: "digest" })
        .map((entry) => entry.threadId),
    ).toEqual([workflowId]);

    // Workflow record carries the result.
    const record = harness.store.getWorkflowRecord(workflowId);
    expect(record?.status).toBe("completed");
    expect(record?.resultJson).toBe("all done");
    expect(record?.script).toContain("all done");

    // Agent record mirrors the terminal state.
    const agentRecord = harness.store.getAgentRecord(workflowId);
    expect(agentRecord?.status).toBe("completed");
    expect(agentRecord?.result).toBe("all done");
    expect(agentRecord?.agentType).toBe("workflow");

    // Lifecycle: started → progress (from log()) → completed.
    expect(harness.events.map((event) => event.type)).toEqual([
      "agent-started",
      "agent-progress",
      "agent-completed",
    ]);
    expect(harness.events[0]?.statusText).toBe("Starting workflow");
    expect(harness.events[1]?.statusText).toBe("Working on the digest");
    expect(harness.events[2]?.result).toBe("all done");
    for (const event of harness.events) {
      expect(event.agentId).toBe(workflowId);
      expect(event.agentType).toBe("workflow");
      expect(event.conversationId).toBe("conv-1");
      expect(event.description).toBe("Summarize inbox digest");
    }
  });

  it("journals agent() calls into runtime_workflow_steps with running→completed transitions", async () => {
    let release!: (outcome: RunAgentOutcome) => void;
    const harness = createHarness(
      () =>
        new Promise<RunAgentOutcome>((resolve) => {
          release = resolve;
        }),
    );
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Fetch the data",
      script:
        'const out = await agent("fetch the report", { label: "fetch-step" });\nreturn out;',
    });
    await vi.waitFor(() => {
      expect(harness.runAgent).toHaveBeenCalledTimes(1);
    });

    // Everything reads as running while the agent is in flight.
    expect(harness.service.isRunning(workflowId)).toBe(true);
    expect(harness.store.getWorkflowRecord(workflowId)?.status).toBe("running");
    expect(harness.store.getAgentRecord(workflowId)?.status).toBe("running");
    const [running] = stepRows(harness, workflowId);
    expect(running?.step_index).toBe(1);
    expect(running?.status).toBe("running");
    expect(running?.label).toBe("fetch-step");
    expect(running?.prompt_hash).toBe(
      crypto
        .createHash("sha256")
        .update("fetch the report")
        .digest("hex")
        .slice(0, 16),
    );
    expect(running?.completed_at).toBeNull();

    const call = harness.runAgent.mock.calls[0]![0];
    expect(call.prompt).toBe("fetch the report");
    expect(call.conversationId).toBe("conv-1");
    expect(call.description).toBe("fetch-step");
    expect(call.agentId).toBe(
      `conv-1::subagent::general::${workflowId}-a1`,
    );

    release({ result: "report contents" });
    await waitForWorkflowStatus(harness, workflowId, "completed");
    const [completed] = stepRows(harness, workflowId);
    expect(completed?.status).toBe("completed");
    expect(completed?.result_json).toBe("report contents");
    expect(completed?.completed_at).not.toBeNull();
    expect(harness.store.getWorkflowRecord(workflowId)?.resultJson).toBe(
      "report contents",
    );
    expect(harness.service.isRunning(workflowId)).toBe(false);
  });

  it("emits agent-progress for every log() line", async () => {
    const harness = createHarness();
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Narrated run",
      script: 'log("step one");\nlog("step two");\nreturn "fin";',
    });
    await waitForWorkflowStatus(harness, workflowId, "completed");
    const progress = harness.events.filter(
      (event) => event.type === "agent-progress",
    );
    expect(progress.map((event) => event.statusText)).toEqual([
      "step one",
      "step two",
    ]);
  });
});

describe("WorkflowService structured output", () => {
  it("parses and validates a fenced json block against the schema", async () => {
    const harness = createHarness(async () => ({
      result: 'Sure!\n```json\n{"count": 42}\n```',
    }));
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Count things",
      script: `return await agent("count things", { schema: ${JSON.stringify(COUNT_SCHEMA)} });`,
    });
    await waitForWorkflowStatus(harness, workflowId, "completed");

    expect(harness.runAgent).toHaveBeenCalledTimes(1);
    const prompt = harness.runAgent.mock.calls[0]![0].prompt;
    expect(prompt).toContain("count things");
    expect(prompt).toContain("matches this JSON Schema");
    expect(prompt).toContain(JSON.stringify(COUNT_SCHEMA));
    expect(harness.store.getWorkflowRecord(workflowId)?.resultJson).toBe(
      JSON.stringify({ count: 42 }, null, 1),
    );
  });

  it("runs exactly one repair agent when the first output fails validation", async () => {
    const harness = createHarness(async ({ description }) =>
      description === "Repair structured output"
        ? { result: '```json\n{"count": 7}\n```' }
        : { result: '```json\n{"count": "seven"}\n```' },
    );
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Count with repair",
      script: `return await agent("count things", { schema: ${JSON.stringify(COUNT_SCHEMA)} });`,
    });
    await waitForWorkflowStatus(harness, workflowId, "completed");

    expect(harness.runAgent).toHaveBeenCalledTimes(2);
    const repairCall = harness.runAgent.mock.calls[1]![0];
    expect(repairCall.description).toBe("Repair structured output");
    expect(repairCall.agentId).toContain("-repair");
    expect(repairCall.prompt).toMatch(
      /^A previous agent was asked to return JSON matching a schema/,
    );
    expect(repairCall.prompt).toContain(JSON.stringify(COUNT_SCHEMA));
    expect(repairCall.prompt).toContain(
      "$.count: expected number, got string",
    );
    expect(repairCall.prompt).toContain('{"count": "seven"}');
    expect(harness.store.getWorkflowRecord(workflowId)?.resultJson).toBe(
      JSON.stringify({ count: 7 }, null, 1),
    );
  });

  it("fails the agent() call when validation fails twice, failing an uncatching script", async () => {
    const harness = createHarness(async () => ({
      result: '```json\n{"count": "never-a-number"}\n```',
    }));
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Stubbornly invalid",
      script: `return await agent("count things", { schema: ${JSON.stringify(COUNT_SCHEMA)} });`,
    });
    await waitForWorkflowStatus(harness, workflowId, "failed");

    expect(harness.runAgent).toHaveBeenCalledTimes(2);
    const record = harness.store.getWorkflowRecord(workflowId);
    expect(record?.error).toContain(
      "failed schema validation after one repair attempt",
    );
    const terminal = harness.events.at(-1);
    expect(terminal?.type).toBe("agent-failed");
    expect(terminal?.error).toContain("after one repair attempt");
    const [step] = stepRows(harness, workflowId);
    expect(step?.status).toBe("failed");
  });

  it("lets parallel() null semantics absorb a double validation failure", async () => {
    const harness = createHarness(async () => ({
      result: '```json\n{"count": "never-a-number"}\n```',
    }));
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Fan out with repair failure",
      script: `return await parallel([() => agent("count things", { schema: ${JSON.stringify(COUNT_SCHEMA)} })]);`,
    });
    await waitForWorkflowStatus(harness, workflowId, "completed");
    expect(harness.store.getWorkflowRecord(workflowId)?.resultJson).toBe(
      JSON.stringify([null], null, 1),
    );
  });
});

describe("WorkflowService failure and cancellation", () => {
  it("fails the workflow when an uncaught agent() outcome carries an error", async () => {
    const harness = createHarness(async () => ({ result: "", error: "boom" }));
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Doomed run",
      script: 'return await agent("do it");',
    });
    await waitForWorkflowStatus(harness, workflowId, "failed");

    const record = harness.store.getWorkflowRecord(workflowId);
    expect(record?.error).toBe("boom");
    expect(record?.resultJson).toBeUndefined();
    expect(harness.store.getAgentRecord(workflowId)?.status).toBe("error");
    expect(harness.store.getAgentRecord(workflowId)?.error).toBe("boom");
    const terminal = harness.events.at(-1);
    expect(terminal?.type).toBe("agent-failed");
    expect(terminal?.error).toBe("boom");
    const [step] = stepRows(harness, workflowId);
    expect(step?.status).toBe("failed");
    expect(step?.error).toBe("boom");
  });

  it("cancelWorkflow aborts a running workflow and finalizes records as canceled", async () => {
    const harness = createHarness(hangUntilAborted);
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Long haul",
      script: 'return await agent("hang forever");',
    });
    await vi.waitFor(() => {
      expect(harness.runAgent).toHaveBeenCalledTimes(1);
    });

    await expect(
      harness.service.cancelWorkflow(workflowId, "User changed plans"),
    ).resolves.toEqual({ canceled: true });
    await waitForWorkflowStatus(harness, workflowId, "canceled");

    expect(harness.store.getWorkflowRecord(workflowId)?.error).toBe(
      "User changed plans",
    );
    expect(harness.store.getAgentRecord(workflowId)?.status).toBe("canceled");
    const terminal = harness.events.at(-1);
    expect(terminal?.type).toBe("agent-canceled");
    expect(terminal?.error).toBe("User changed plans");
    const [step] = stepRows(harness, workflowId);
    expect(step?.status).toBe("canceled");
    expect(harness.service.isRunning(workflowId)).toBe(false);
  });

  it("cancelWorkflow returns { canceled: false } for unknown keys", async () => {
    const harness = createHarness();
    await expect(
      harness.service.cancelWorkflow("no-such-workflow"),
    ).resolves.toEqual({ canceled: false });
  });

  it("finalizes a stale 'running' record from a dead worker without emitting events", async () => {
    const harness = createHarness();
    const resolved = harness.store.resolveOrCreateActiveThread({
      conversationId: "conv-1",
      agentType: "workflow",
      nameHint: "Orphaned run",
    });
    harness.store.createWorkflowRecord({
      workflowKey: resolved.threadId,
      conversationId: "conv-1",
      description: "Orphaned run",
      script: "return 1;",
    });

    await expect(
      harness.service.cancelWorkflow(resolved.threadId, "Sweeping stale"),
    ).resolves.toEqual({ canceled: true });
    const record = harness.store.getWorkflowRecord(resolved.threadId);
    expect(record?.status).toBe("canceled");
    expect(record?.error).toBe("Sweeping stale");
    expect(harness.events).toHaveLength(0);
  });
});

describe("WorkflowService groups", () => {
  it("startWorkflow with a group label mints the group and tags the thread row", async () => {
    const harness = createHarness();
    const { workflowId, groupKey, groupLabel } =
      await harness.service.startWorkflow({
        conversationId: "conv-1",
        description: "Plan flights",
        script: 'return "ok";',
        group: "Trip planning",
      });
    expect(groupKey).toBe("grp-trip-planning");
    expect(groupLabel).toBe("Trip planning");
    expect(harness.store.getThreadGroup(workflowId)).toEqual({
      groupKey: "grp-trip-planning",
      groupLabel: "Trip planning",
    });
    await waitForWorkflowStatus(harness, workflowId, "completed");
  });

  it("cancelGroupWorkflows cancels only the matching group's workflows", async () => {
    const harness = createHarness(hangUntilAborted);
    const alpha = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Alpha work",
      script: 'return await agent("hang");',
      group: "Alpha squad",
    });
    const beta = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Beta work",
      script: 'return await agent("hang");',
      group: "Beta squad",
    });
    await vi.waitFor(() => {
      expect(harness.runAgent).toHaveBeenCalledTimes(2);
    });

    const canceled = await harness.service.cancelGroupWorkflows(
      alpha.groupKey!,
      "Group canceled",
    );
    expect(canceled).toEqual([alpha.workflowId]);
    await waitForWorkflowStatus(harness, alpha.workflowId, "canceled");
    expect(harness.store.getWorkflowRecord(alpha.workflowId)?.error).toBe(
      "Group canceled",
    );

    // The other group keeps running untouched.
    expect(harness.service.isRunning(beta.workflowId)).toBe(true);
    expect(harness.store.getWorkflowRecord(beta.workflowId)?.status).toBe(
      "running",
    );

    await harness.service.cancelWorkflow(beta.workflowId);
    await waitForWorkflowStatus(harness, beta.workflowId, "canceled");
  });
});

describe("WorkflowService agent-call cap", () => {
  it(`fails the run after ${WORKFLOW_MAX_AGENT_CALLS} agent() calls`, async () => {
    const harness = createHarness();
    const { workflowId } = await harness.service.startWorkflow({
      conversationId: "conv-1",
      description: "Greedy loop",
      script: [
        `for (let i = 0; i < ${WORKFLOW_MAX_AGENT_CALLS + 1}; i += 1) {`,
        '  await agent("call " + i);',
        "}",
        'return "unreachable";',
      ].join("\n"),
    });
    await waitForWorkflowStatus(harness, workflowId, "failed", 15_000);

    expect(harness.runAgent).toHaveBeenCalledTimes(WORKFLOW_MAX_AGENT_CALLS);
    expect(harness.store.getWorkflowRecord(workflowId)?.error).toBe(
      `Workflow exceeded the ${WORKFLOW_MAX_AGENT_CALLS}-agent cap.`,
    );
    const terminal = harness.events.at(-1);
    expect(terminal?.type).toBe("agent-failed");
  });
});
