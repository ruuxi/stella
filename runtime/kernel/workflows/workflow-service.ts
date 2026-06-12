/**
 * Workflow runs: orchestrator-authored scripts that fan work out to
 * ephemeral agents and return one synthesized result.
 *
 * From the outside a workflow IS one agent: it owns a `runtime_threads`
 * row (agent_type 'workflow') so slot budgeting, "Other Threads"
 * rendering, search, and pause routing need no special cases; it emits
 * the standard agent lifecycle events so the Activity UI shows one row
 * whose status text is the script's `log()` narration, and the
 * orchestrator receives exactly one `[Agent completed]` notice carrying
 * the script's return value. The agents the script spawns are
 * ephemeral: they never occupy work slots and never notify the
 * orchestrator — their results flow through the script.
 */

import crypto from "node:crypto";
import type { AgentLifecycleEvent } from "../agents/local-agent-manager.js";
import {
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "../agents/local-agent-manager.js";
import type { SessionStore } from "../storage/session-store.js";
import { WORKFLOW_AGENT_TYPE } from "../runtime-threads.js";
import {
  extractJsonValue,
  validateAgainstSchema,
} from "./json-schema.js";
import {
  assertWorkflowScriptParses,
  runWorkflowScript,
  type WorkflowAgentOptions,
} from "./script-runtime.js";

export const WORKFLOW_MAX_CONCURRENT_AGENTS = 4;
export const WORKFLOW_MAX_AGENT_CALLS = 64;
export const WORKFLOW_TIMEOUT_MS = 45 * 60_000;
const WORKFLOW_RESULT_MAX_CHARS = 30_000;
/**
 * Cap on persisted log() narration events per workflow. Every narration
 * line becomes a durable chat event plus a renderer notification, so an
 * unbounded model-authored logging loop would bloat the conversation's
 * event table and flood the Activity surfaces.
 */
export const WORKFLOW_MAX_LOG_EVENTS = 200;

export type WorkflowEphemeralAgentRunner = (args: {
  conversationId: string;
  agentId: string;
  description: string;
  prompt: string;
  rootRunId?: string;
  selfModFeature?: { featureId: string; featureTitle: string };
  signal: AbortSignal;
}) => Promise<{ result: string; error?: string; interrupted?: boolean }>;

type RunningWorkflow = {
  workflowKey: string;
  conversationId: string;
  rootRunId?: string;
  description: string;
  groupKey?: string;
  groupLabel?: string;
  controller: AbortController;
  agentCalls: number;
  logEvents: number;
  settled: boolean;
  startedAt: number;
};

const hashPrompt = (prompt: string): string =>
  crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);

const serializeResult = (value: unknown): string => {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value ?? null, null, 1) ?? "null";
  return text.length <= WORKFLOW_RESULT_MAX_CHARS
    ? text
    : `${text.slice(0, WORKFLOW_RESULT_MAX_CHARS)}\n[truncated]`;
};

const withSchemaInstructions = (
  prompt: string,
  schema: Record<string, unknown>,
): string =>
  [
    prompt.trim(),
    "",
    "---",
    "Your reply is consumed by a program, not a person. End your final message with ONLY a fenced ```json code block containing a single JSON value that matches this JSON Schema exactly — no prose after the block:",
    "```json",
    JSON.stringify(schema),
    "```",
  ].join("\n");

const buildRepairPrompt = (args: {
  schema: Record<string, unknown>;
  rawOutput: string;
  errors: string[];
}): string =>
  [
    "A previous agent was asked to return JSON matching a schema, but its output failed validation. Produce the corrected JSON.",
    "",
    `JSON Schema:\n\`\`\`json\n${JSON.stringify(args.schema)}\n\`\`\``,
    "",
    `Previous output:\n${args.rawOutput.slice(0, 8_000)}`,
    "",
    `Validation errors:\n${args.errors.map((error) => `- ${error}`).join("\n")}`,
    "",
    "Reply with ONLY a fenced ```json code block containing the corrected JSON value. Preserve the previous output's substance; fix only the structure.",
  ].join("\n");

export class WorkflowService {
  private readonly running = new Map<string, RunningWorkflow>();

  constructor(
    private readonly deps: {
      store: SessionStore;
      runAgent: WorkflowEphemeralAgentRunner;
      emitLifecycleEvent: (event: AgentLifecycleEvent) => void;
    },
  ) {
    // A worker crash leaves workflows stranded as 'running'; finalize
    // them quietly on startup so records (and any agent snapshots) tell
    // the truth and stale keys remain cancelable/searchable correctly.
    try {
      for (const workflowKey of this.deps.store.listWorkflowKeysByStatus(
        "running",
      )) {
        const record = this.deps.store.getWorkflowRecord(workflowKey);
        if (!record) continue;
        this.finalize(
          {
            workflowKey,
            conversationId: record.conversationId,
            description: record.description,
            controller: new AbortController(),
            agentCalls: 0,
            logEvents: 0,
            settled: false,
            startedAt: Date.now(),
          },
          "canceled",
          undefined,
          "Interrupted by a Stella restart.",
          { emitEvent: false },
        );
      }
    } catch (error) {
      console.warn(
        "[workflows] stale-run sweep failed (continuing):",
        (error as Error).message,
      );
    }
  }

  /**
   * Validate, register, and launch a workflow. Returns as soon as the
   * script is running in the background; completion lands as one
   * agent-completed lifecycle event on the workflow's key. Throws on
   * script syntax errors (surfaced as the tool error) and on group
   * member-cap violations from thread resolution.
   */
  async startWorkflow(args: {
    conversationId: string;
    description: string;
    script: string;
    group?: string;
    rootRunId?: string;
  }): Promise<{ workflowId: string; groupKey?: string; groupLabel?: string }> {
    assertWorkflowScriptParses(args.script);
    const resolved = this.deps.store.resolveOrCreateActiveThread({
      conversationId: args.conversationId,
      agentType: WORKFLOW_AGENT_TYPE,
      nameHint: args.description,
      ...(args.group ? { group: args.group } : {}),
    });
    const workflowKey = resolved.threadId;
    const now = Date.now();
    this.deps.store.createWorkflowRecord({
      workflowKey,
      conversationId: args.conversationId,
      description: args.description,
      script: args.script,
    });
    this.deps.store.saveAgentRecord({
      threadId: workflowKey,
      conversationId: args.conversationId,
      agentType: WORKFLOW_AGENT_TYPE,
      description: args.description,
      agentDepth: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });

    const workflow: RunningWorkflow = {
      workflowKey,
      conversationId: args.conversationId,
      ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
      description: args.description,
      ...(resolved.groupKey ? { groupKey: resolved.groupKey } : {}),
      ...(resolved.groupLabel ? { groupLabel: resolved.groupLabel } : {}),
      controller: new AbortController(),
      agentCalls: 0,
      logEvents: 0,
      settled: false,
      startedAt: now,
    };
    this.running.set(workflowKey, workflow);

    this.emit(workflow, {
      type: "agent-started",
      statusText: "Starting workflow",
    });
    void this.execute(workflow, args.script);

    return {
      workflowId: workflowKey,
      ...(resolved.groupKey ? { groupKey: resolved.groupKey } : {}),
      ...(resolved.groupLabel ? { groupLabel: resolved.groupLabel } : {}),
    };
  }

  isRunning(workflowKey: string): boolean {
    return this.running.has(workflowKey);
  }

  /**
   * Cancel a workflow by key. Running workflows abort their script and
   * every in-flight ephemeral agent; stale 'running' records from a
   * crashed worker are finalized as canceled.
   */
  async cancelWorkflow(
    workflowKey: string,
    reason?: string,
  ): Promise<{ canceled: boolean }> {
    const active = this.running.get(workflowKey);
    if (active) {
      active.controller.abort(new Error(reason ?? "Canceled"));
      return { canceled: true };
    }
    const record = this.deps.store.getWorkflowRecord(workflowKey);
    if (record && record.status === "running") {
      this.finalize(
        {
          workflowKey,
          conversationId: record.conversationId,
          description: record.description,
          controller: new AbortController(),
          agentCalls: 0,
          logEvents: 0,
          settled: false,
          startedAt: Date.now(),
        },
        "canceled",
        undefined,
        reason ?? "Canceled",
        { emitEvent: false },
      );
      return { canceled: true };
    }
    return { canceled: false };
  }

  /** Cancel every running workflow that belongs to a work group. */
  async cancelGroupWorkflows(
    groupKey: string,
    reason?: string,
  ): Promise<string[]> {
    const canceled: string[] = [];
    for (const workflow of [...this.running.values()]) {
      if (workflow.groupKey === groupKey) {
        await this.cancelWorkflow(workflow.workflowKey, reason);
        canceled.push(workflow.workflowKey);
      }
    }
    return canceled;
  }

  shutdown(): void {
    for (const workflow of [...this.running.values()]) {
      // The manager's shutdown sentinel — buildAgentEventPrompt suppresses
      // it, so quitting with a running workflow does not persist a hidden
      // "[Task canceled]" orchestrator turn.
      workflow.controller.abort(new Error(AGENT_SHUTDOWN_CANCEL_REASON));
    }
  }

  private async execute(
    workflow: RunningWorkflow,
    script: string,
  ): Promise<void> {
    const timeout = setTimeout(() => {
      workflow.controller.abort(
        new Error(
          `Workflow timed out after ${Math.round(WORKFLOW_TIMEOUT_MS / 60_000)} minutes.`,
        ),
      );
    }, WORKFLOW_TIMEOUT_MS);
    // Decide the outcome first, finalize exactly once afterwards — a
    // failure INSIDE finalize must never re-enter it from a catch and
    // overwrite a completed result with 'failed'.
    let value: unknown;
    let runError: Error | undefined;
    try {
      value = await runWorkflowScript({
        script,
        agent: (prompt, opts) => this.callAgent(workflow, prompt, opts),
        log: (message) => this.emitNarration(workflow, message),
        signal: workflow.controller.signal,
        maxConcurrentAgents: WORKFLOW_MAX_CONCURRENT_AGENTS,
      });
    } catch (error) {
      runError = error as Error;
    }
    clearTimeout(timeout);
    try {
      if (!runError) {
        this.finalize(workflow, "completed", serializeResult(value));
      } else if (workflow.controller.signal.aborted) {
        const reason =
          (workflow.controller.signal.reason as Error | undefined)?.message ??
          runError.message ??
          "Canceled";
        this.finalize(workflow, "canceled", undefined, reason);
      } else {
        this.finalize(
          workflow,
          "failed",
          undefined,
          runError.message || "Workflow failed",
        );
      }
    } catch (error) {
      console.warn(
        "[workflows] finalize failed:",
        (error as Error).message,
      );
    } finally {
      // Removed only after finalize so a concurrent cancelWorkflow keeps
      // hitting the in-memory path (a no-op abort) instead of the
      // stale-record path, which would double-finalize.
      this.running.delete(workflow.workflowKey);
    }
  }

  private finalize(
    workflow: RunningWorkflow,
    status: "completed" | "failed" | "canceled",
    resultText?: string,
    error?: string,
    options?: { emitEvent?: boolean },
  ): void {
    if (workflow.settled) return;
    workflow.settled = true;
    const now = Date.now();
    this.deps.store.finalizeWorkflowRecord({
      workflowKey: workflow.workflowKey,
      status,
      ...(resultText ? { resultJson: resultText } : {}),
      ...(error ? { error } : {}),
    });
    // Stale-cancel and startup-sweep paths construct a synthetic
    // RunningWorkflow; keep the original start time from the persisted
    // record instead of clobbering it with "now".
    const existingRecord = this.deps.store.getAgentRecord?.(
      workflow.workflowKey,
    );
    this.deps.store.saveAgentRecord({
      threadId: workflow.workflowKey,
      conversationId: workflow.conversationId,
      agentType: WORKFLOW_AGENT_TYPE,
      description: workflow.description,
      agentDepth: 1,
      status: status === "failed" ? "error" : status,
      startedAt: existingRecord?.startedAt ?? workflow.startedAt,
      completedAt: now,
      ...(resultText ? { result: resultText } : {}),
      ...(error ? { error } : {}),
      updatedAt: now,
    });
    if (options?.emitEvent === false) return;
    if (status === "completed") {
      this.emit(workflow, {
        type: "agent-completed",
        ...(resultText ? { result: resultText } : {}),
      });
    } else if (status === "canceled") {
      // Pause-initiated cancels reuse the manager's sentinel so the
      // runner skips the hidden "[Task canceled]" orchestrator turn,
      // exactly like pausing a regular agent.
      this.emit(workflow, {
        type: "agent-canceled",
        error: error ?? AGENT_PAUSE_CANCEL_REASON,
      });
    } else {
      this.emit(workflow, {
        type: "agent-failed",
        error: error ?? "Workflow failed",
      });
    }
  }

  private emitNarration(workflow: RunningWorkflow, message: string): void {
    workflow.logEvents += 1;
    if (workflow.logEvents > WORKFLOW_MAX_LOG_EVENTS) {
      if (workflow.logEvents === WORKFLOW_MAX_LOG_EVENTS + 1) {
        console.warn(
          `[workflows] ${workflow.workflowKey} exceeded ${WORKFLOW_MAX_LOG_EVENTS} log() events; further narration is dropped.`,
        );
      }
      return;
    }
    this.emit(workflow, { type: "agent-progress", statusText: message });
  }

  private emit(
    workflow: RunningWorkflow,
    event: Pick<AgentLifecycleEvent, "type"> &
      Partial<
        Pick<AgentLifecycleEvent, "result" | "error" | "statusText">
      >,
  ): void {
    this.deps.emitLifecycleEvent({
      conversationId: workflow.conversationId,
      ...(workflow.rootRunId ? { rootRunId: workflow.rootRunId } : {}),
      agentId: workflow.workflowKey,
      agentType: WORKFLOW_AGENT_TYPE,
      description: workflow.description,
      ...(workflow.groupKey
        ? {
            groupKey: workflow.groupKey,
            ...(workflow.groupLabel ? { groupLabel: workflow.groupLabel } : {}),
          }
        : {}),
      ...event,
    });
  }

  /**
   * Self-mod commits made by ANY step of this workflow attribute to one
   * feature: the workflow's group when grouped, else the workflow run
   * itself — never the per-step ephemeral agent id.
   */
  private selfModFeatureFor(workflow: RunningWorkflow): {
    featureId: string;
    featureTitle: string;
  } {
    return {
      featureId: workflow.groupKey ?? workflow.workflowKey,
      featureTitle: workflow.groupLabel ?? workflow.description,
    };
  }

  private async callAgent(
    workflow: RunningWorkflow,
    prompt: string,
    opts?: WorkflowAgentOptions,
  ): Promise<unknown> {
    if (workflow.controller.signal.aborted) {
      throw new Error("Workflow was canceled.");
    }
    workflow.agentCalls += 1;
    if (workflow.agentCalls > WORKFLOW_MAX_AGENT_CALLS) {
      throw new Error(
        `Workflow exceeded the ${WORKFLOW_MAX_AGENT_CALLS}-agent cap.`,
      );
    }
    const stepIndex = workflow.agentCalls;
    const label = opts?.label ?? `agent-${stepIndex}`;
    const agentId = `${workflow.conversationId}::subagent::general::${workflow.workflowKey}-a${stepIndex}`;
    const schema = opts?.schema;
    const finalPrompt = schema
      ? withSchemaInstructions(prompt, schema)
      : prompt;
    this.deps.store.recordWorkflowStepStart({
      workflowKey: workflow.workflowKey,
      stepIndex,
      label,
      promptHash: hashPrompt(prompt),
    });
    try {
      const outcome = await this.deps.runAgent({
        conversationId: workflow.conversationId,
        agentId,
        description: label,
        prompt: finalPrompt,
        ...(workflow.rootRunId ? { rootRunId: workflow.rootRunId } : {}),
        selfModFeature: this.selfModFeatureFor(workflow),
        signal: workflow.controller.signal,
      });
      if (outcome.error) {
        throw new Error(outcome.error);
      }
      if (outcome.interrupted) {
        // An interrupted turn returns whatever partial text was streamed —
        // journaling that as 'completed' would hand the script silently
        // truncated data.
        throw new Error("Agent run was interrupted before it finished.");
      }
      const value = schema
        ? await this.coerceStructuredOutput(workflow, schema, outcome.result)
        : outcome.result;
      this.deps.store.recordWorkflowStepEnd({
        workflowKey: workflow.workflowKey,
        stepIndex,
        status: "completed",
        resultJson: serializeResult(value),
      });
      return value;
    } catch (error) {
      this.deps.store.recordWorkflowStepEnd({
        workflowKey: workflow.workflowKey,
        stepIndex,
        status: workflow.controller.signal.aborted ? "canceled" : "failed",
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Parse + validate an agent's structured output; on failure run ONE
   * repair agent that receives the schema, the raw output, and the
   * validation errors. A second failure throws — the script's
   * parallel()/pipeline() null semantics (or its own try/catch) decide
   * what that means for the run.
   */
  private async coerceStructuredOutput(
    workflow: RunningWorkflow,
    schema: Record<string, unknown>,
    rawOutput: string,
  ): Promise<unknown> {
    const firstAttempt = extractJsonValue(rawOutput);
    if (firstAttempt !== undefined) {
      const validation = validateAgainstSchema(firstAttempt, schema);
      if (validation.valid) return firstAttempt;
      return await this.repairStructuredOutput(
        workflow,
        schema,
        rawOutput,
        validation.errors,
      );
    }
    return await this.repairStructuredOutput(workflow, schema, rawOutput, [
      "$: no parseable JSON found in the output",
    ]);
  }

  private async repairStructuredOutput(
    workflow: RunningWorkflow,
    schema: Record<string, unknown>,
    rawOutput: string,
    errors: string[],
  ): Promise<unknown> {
    workflow.agentCalls += 1;
    if (workflow.agentCalls > WORKFLOW_MAX_AGENT_CALLS) {
      throw new Error(
        `Workflow exceeded the ${WORKFLOW_MAX_AGENT_CALLS}-agent cap during structured-output repair.`,
      );
    }
    const repairId = `${workflow.conversationId}::subagent::general::${workflow.workflowKey}-repair${workflow.agentCalls}`;
    const outcome = await this.deps.runAgent({
      conversationId: workflow.conversationId,
      agentId: repairId,
      description: "Repair structured output",
      prompt: buildRepairPrompt({ schema, rawOutput, errors }),
      ...(workflow.rootRunId ? { rootRunId: workflow.rootRunId } : {}),
      selfModFeature: this.selfModFeatureFor(workflow),
      signal: workflow.controller.signal,
    });
    if (outcome.error) {
      throw new Error(`Structured output repair failed: ${outcome.error}`);
    }
    const repaired = extractJsonValue(outcome.result);
    if (repaired === undefined) {
      throw new Error(
        "Agent output did not contain valid JSON after one repair attempt.",
      );
    }
    const validation = validateAgainstSchema(repaired, schema);
    if (!validation.valid) {
      throw new Error(
        `Agent output failed schema validation after one repair attempt: ${validation.errors.join("; ")}`,
      );
    }
    return repaired;
  }
}
