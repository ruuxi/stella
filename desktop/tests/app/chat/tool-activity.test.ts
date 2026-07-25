import { describe, expect, it } from "vitest";
import { deriveToolActivity } from "@/features/chat/lib/tool-activity";
import type { EventRecord } from "@/features/chat/lib/event-transforms";

const req = (
  requestId: string,
  toolName: string,
  agentType: string | undefined,
  args: Record<string, unknown> = {},
): EventRecord =>
  ({
    _id: `req:${requestId}`,
    timestamp: 1,
    type: "tool_request",
    requestId,
    payload: { toolName, args, ...(agentType ? { agentType } : {}) },
  }) as unknown as EventRecord;

const res = (
  requestId: string,
  toolName: string,
  agentType: string | undefined,
): EventRecord =>
  ({
    _id: `res:${requestId}`,
    timestamp: 2,
    type: "tool_result",
    requestId,
    payload: { toolName, result: "ok", ...(agentType ? { agentType } : {}) },
  }) as unknown as EventRecord;

describe("deriveToolActivity orchestrator-only gating", () => {
  it("renders a chip for the orchestrator's own web search", () => {
    const group = deriveToolActivity([
      req("r1", "web", "orchestrator", { query: "carplay entitlement" }),
      res("r1", "web", "orchestrator"),
    ]);
    expect(group?.summary).toBe("Searched the web");
  });

  it("renders chips for the orchestrator's own settled calls (Claude-CLI cased names)", () => {
    const group = deriveToolActivity([
      req("r1", "Read", "orchestrator", { path: "/a/b.ts" }),
      res("r1", "Read", "orchestrator"),
      req("r2", "Read", "orchestrator", { path: "/a/c.ts" }),
      res("r2", "Read", "orchestrator"),
    ]);
    expect(group?.summary).toBe("Read 2 files");
  });

  it("treats an unstamped (absent agentType) call as the orchestrator", () => {
    const group = deriveToolActivity([
      req("r1", "exec_command", undefined, { cmd: "ls" }),
      res("r1", "exec_command", undefined),
    ]);
    expect(group?.summary).toBe("Ran a command");
  });

  it("suppresses a spawned sub-agent's (general) tool calls", () => {
    const group = deriveToolActivity([
      req("r1", "exec_command", "general", { cmd: "ls" }),
      res("r1", "exec_command", "general"),
    ]);
    expect(group).toBeUndefined();
  });

  it("suppresses orchestrator-reserved internal builtins (schedule)", () => {
    const group = deriveToolActivity([
      req("r1", "web", "schedule", { query: "x" }),
      res("r1", "web", "schedule"),
    ]);
    expect(group).toBeUndefined();
  });

  it("keeps delegation tools out of the generic tool trace", () => {
    const group = deriveToolActivity([
      req("r1", "spawn_agent", "orchestrator", {
        prompt: "Coordinate the launch",
      }),
      res("r1", "spawn_agent", "orchestrator"),
    ]);
    expect(group).toBeUndefined();
  });

  it("keeps only the orchestrator's calls in a mixed turn", () => {
    const group = deriveToolActivity([
      req("r1", "web", "orchestrator", { query: "x" }),
      res("r1", "web", "orchestrator"),
      req("r2", "exec_command", "general", { cmd: "ls" }),
      res("r2", "exec_command", "general"),
    ]);
    expect(group?.summary).toBe("Searched the web");
    expect(group?.steps).toHaveLength(1);
  });
});
