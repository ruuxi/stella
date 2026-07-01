import { describe, expect, it } from "vitest";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  buildAgentCompletionSections,
  buildAgentMetaMap,
  deriveAgentCompletionFiles,
} from "@/features/chat/lib/agent-completion";

const ev = (overrides: Partial<EventRecord>): EventRecord => ({
  _id: overrides._id ?? "e",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "agent-progress",
  payload: overrides.payload ?? {},
  ...overrides,
});

const started = (
  agentId: string,
  description: string,
  opts: { agentType?: string; groupLabel?: string; timestamp?: number } = {},
): EventRecord =>
  ev({
    _id: `started:${agentId}:${opts.timestamp ?? 1}`,
    timestamp: opts.timestamp ?? 1,
    type: "agent-started",
    payload: {
      agentId,
      description,
      agentType: opts.agentType ?? "general",
      ...(opts.groupLabel ? { groupLabel: opts.groupLabel } : {}),
    },
  });

const completed = (
  agentId: string,
  paths: string[],
  timestamp = 100,
): EventRecord =>
  ev({
    _id: `completed:${agentId}:${timestamp}`,
    timestamp,
    type: "agent-completed",
    payload: {
      agentId,
      result: "done",
      producedFiles: paths.map((path) => ({ kind: { type: "add" }, path })),
    },
  });

describe("deriveAgentCompletionFiles", () => {
  it("groups produced files per agent from a row's agent-completed events", () => {
    const files = deriveAgentCompletionFiles([
      completed("a1", ["/out/report.md"]),
      completed("a2", ["/out/chart.png", "/out/data.csv"]),
    ]);
    expect([...files.keys()].sort()).toEqual(["a1", "a2"]);
    expect(files.get("a1")!.map((f) => f.path)).toEqual(["/out/report.md"]);
    expect(files.get("a2")!.map((f) => f.path).sort()).toEqual([
      "/out/chart.png",
      "/out/data.csv",
    ]);
  });

  it("ignores tool_result events (orchestrator-direct files are not agent pills)", () => {
    const files = deriveAgentCompletionFiles([
      ev({
        _id: "r1",
        type: "tool_result",
        timestamp: 5,
        payload: {
          toolName: "exec_command",
          producedFiles: [{ kind: { type: "add" }, path: "/out/direct.png" }],
        },
      }),
    ]);
    expect(files.size).toBe(0);
  });
});

describe("buildAgentCompletionSections", () => {
  it("titles a section from the agent's spawn description and keeps its pills", () => {
    const meta = buildAgentMetaMap([
      started("a1", "Research flights to Tokyo"),
    ]);
    const sections = buildAgentCompletionSections(
      [completed("a1", ["/out/flights.md"])],
      meta,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.agentId).toBe("a1");
    expect(sections[0]!.title).toBe("Research flights to Tokyo");
    expect(sections[0]!.files.map((f) => f.path)).toEqual(["/out/flights.md"]);
  });

  it("keeps multiple agents sectionalized — never one merged card", () => {
    const meta = buildAgentMetaMap([
      started("a1", "Build the report"),
      started("a2", "Render the chart"),
    ]);
    const sections = buildAgentCompletionSections(
      [
        completed("a1", ["/out/report.md"]),
        completed("a2", ["/out/chart.png"]),
      ],
      meta,
    );
    expect(sections.map((s) => s.agentId)).toEqual(["a1", "a2"]);
    expect(sections.map((s) => s.title)).toEqual([
      "Build the report",
      "Render the chart",
    ]);
  });

  it("excludes orchestrator-reserved builtin agents", () => {
    const meta = buildAgentMetaMap([
      started("schedule-1", "Schedule a reminder", { agentType: "schedule" }),
    ]);
    const sections = buildAgentCompletionSections(
      [completed("schedule-1", ["/out/x.md"])],
      meta,
    );
    expect(sections).toHaveLength(0);
  });

  it("falls back to a generic title when the spawn aged out of the window", () => {
    const sections = buildAgentCompletionSections(
      [completed("a1", ["/out/report.md"])],
      new Map(),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Task");
  });
});

describe("append-only across a send_input re-run", () => {
  it("a later completion carries only its own run's files (per-row scoping)", () => {
    // First run completes on an earlier row with one file; the send_input
    // re-run completes on a LATER row with a different file. Each row builds
    // its own sections from its OWN agent-completed events, so the second
    // card never re-shows the first file.
    const meta = buildAgentMetaMap([
      started("a1", "Build the report", { timestamp: 1 }),
      started("a1", "Build the report", { timestamp: 50 }),
    ]);
    const firstRow = buildAgentCompletionSections(
      [completed("a1", ["/out/v1.md"], 10)],
      meta,
    );
    const secondRow = buildAgentCompletionSections(
      [completed("a1", ["/out/v2.md"], 60)],
      meta,
    );
    expect(firstRow[0]!.files.map((f) => f.path)).toEqual(["/out/v1.md"]);
    expect(secondRow[0]!.files.map((f) => f.path)).toEqual(["/out/v2.md"]);
  });
});
