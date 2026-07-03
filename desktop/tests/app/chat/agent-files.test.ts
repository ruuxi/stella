import { describe, expect, it } from "vitest";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  agentFilesSignature,
  deriveAgentFilesMap,
  mergeAgentFileEvents,
} from "@/features/workspace-display/agent-files";

const ev = (overrides: Partial<EventRecord>): EventRecord => ({
  _id: overrides._id ?? "e",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "agent-progress",
  payload: overrides.payload ?? {},
  ...overrides,
});

/** An agent-completed event that produced a file under `/path`. */
const completedWithFile = (
  id: string,
  agentId: string,
  path: string,
  timestamp = 100,
): EventRecord =>
  ev({
    _id: id,
    timestamp,
    type: "agent-completed",
    payload: {
      agentId,
      producedFiles: [{ kind: { type: "add" }, path }],
    },
  });

/** A non-file lifecycle event (the per-token streaming flood). */
const progress = (
  id: string,
  agentId: string,
  timestamp: number,
): EventRecord =>
  ev({
    _id: id,
    timestamp,
    type: "agent-progress",
    payload: { agentId, statusText: `working ${id}` },
  });

describe("agentFilesSignature — cache gating", () => {
  it("is unchanged when only non-file events are appended (streaming flood)", () => {
    const base: EventRecord[] = [
      progress("p1", "a1", 1),
      completedWithFile("c1", "a1", "/a.md", 2),
    ];
    // Next delta: the activity window is refetched (new array, new objects)
    // with extra progress/reasoning events — but no file change.
    const next: EventRecord[] = [
      progress("p1", "a1", 1),
      completedWithFile("c1", "a1", "/a.md", 2),
      progress("p2", "a1", 3),
      ev({ _id: "r1", timestamp: 4, type: "agent-reasoning", payload: { agentId: "a1" } }),
    ];
    expect(agentFilesSignature(next)).toBe(agentFilesSignature(base));
  });

  it("changes when a new file event lands", () => {
    const before = [completedWithFile("c1", "a1", "/a.md", 2)];
    const after = [
      completedWithFile("c1", "a1", "/a.md", 2),
      completedWithFile("c2", "a1", "/b.md", 5),
    ];
    expect(agentFilesSignature(after)).not.toBe(agentFilesSignature(before));
  });

  it("changes when an existing file event's file count changes", () => {
    const before = [completedWithFile("c1", "a1", "/a.md", 2)];
    const after = [
      ev({
        _id: "c1",
        timestamp: 2,
        type: "agent-completed",
        payload: {
          agentId: "a1",
          producedFiles: [
            { kind: { type: "add" }, path: "/a.md" },
            { kind: { type: "add" }, path: "/b.md" },
          ],
        },
      }),
    ];
    expect(agentFilesSignature(after)).not.toBe(agentFilesSignature(before));
  });

  it("ignores events without an agentId", () => {
    const withAgent = [completedWithFile("c1", "a1", "/a.md", 2)];
    const plusOrphan = [
      completedWithFile("c1", "a1", "/a.md", 2),
      // Same file payload shape but no agentId → not attributable to an agent.
      ev({
        _id: "orphan",
        timestamp: 3,
        type: "tool_result",
        payload: { producedFiles: [{ kind: { type: "add" }, path: "/z.md" }] },
      }),
    ];
    expect(agentFilesSignature(plusOrphan)).toBe(
      agentFilesSignature(withAgent),
    );
  });

  it("equal signatures correspond to equal derived maps (gating is safe)", () => {
    const base: EventRecord[] = [
      progress("p1", "a1", 1),
      completedWithFile("c1", "a1", "/a.md", 2),
      completedWithFile("c2", "a2", "/b.md", 3),
    ];
    const nextNoFileChange: EventRecord[] = [
      ...base.map((e) => ({ ...e })), // fresh objects, as a refetch would
      progress("p9", "a1", 9),
    ];
    expect(agentFilesSignature(nextNoFileChange)).toBe(
      agentFilesSignature(base),
    );
    // Same signature ⇒ deriveAgentFilesMap yields the same per-agent files.
    const a = deriveAgentFilesMap(base);
    const b = deriveAgentFilesMap(nextNoFileChange);
    const norm = (m: Map<string, { path: string }[]>) =>
      [...m.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([agent, files]) => [agent, files.map((f) => f.path)]);
    expect(norm(b)).toEqual(norm(a));
    expect(norm(a)).toEqual([
      ["a1", ["/a.md"]],
      ["a2", ["/b.md"]],
    ]);
  });
});

/** A live tool_result stamped with the spawned agent's id. */
const toolResultWithFile = (
  id: string,
  agentId: string,
  path: string,
  timestamp: number,
): EventRecord =>
  ev({
    _id: id,
    timestamp,
    type: "tool_result",
    payload: {
      agentId,
      toolName: "Write",
      fileChanges: [{ kind: { type: "add" }, path }],
    },
  });

describe("mergeAgentFileEvents — live per-agent file sourcing", () => {
  it("surfaces a running agent's tool_result files before any completion", () => {
    const activities = [progress("p1", "a1", 1)];
    const fileEvents = [toolResultWithFile("t1", "a1", "/live.md", 2)];
    const merged = mergeAgentFileEvents(activities, fileEvents);
    const files = deriveAgentFilesMap(merged);
    expect(files.get("a1")?.map((f) => f.path)).toEqual(["/live.md"]);
  });

  it("returns the activities array untouched when nothing merges in", () => {
    const activities = [
      progress("p1", "a1", 1),
      completedWithFile("c1", "a1", "/a.md", 2),
    ];
    // Empty files window.
    expect(mergeAgentFileEvents(activities, [])).toBe(activities);
    // File events without an agentId (orchestrator direct writes) and
    // non-file tool_results never merge in.
    expect(
      mergeAgentFileEvents(activities, [
        ev({
          _id: "orphan",
          timestamp: 3,
          type: "tool_result",
          payload: { fileChanges: [{ kind: { type: "add" }, path: "/z.md" }] },
        }),
        ev({
          _id: "nofile",
          timestamp: 4,
          type: "tool_result",
          payload: { agentId: "a1", toolName: "Read" },
        }),
      ]),
    ).toBe(activities);
    // Events already present in the activity window (agent-completed lives
    // in both feeds) dedupe by _id.
    expect(
      mergeAgentFileEvents(activities, [
        completedWithFile("c1", "a1", "/a.md", 2),
      ]),
    ).toBe(activities);
  });

  it("does not double-list a file reported live and in the completion rollup", () => {
    const activities = [
      progress("p1", "a1", 1),
      completedWithFile("c1", "a1", "/a.md", 10),
    ];
    const fileEvents = [
      toolResultWithFile("t1", "a1", "/a.md", 5),
      completedWithFile("c1", "a1", "/a.md", 10),
    ];
    const merged = mergeAgentFileEvents(activities, fileEvents);
    const files = deriveAgentFilesMap(merged);
    expect(files.get("a1")?.map((f) => f.path)).toEqual(["/a.md"]);
    // Most-recent occurrence wins: the rollup's timestamp sticks.
    expect(files.get("a1")?.[0]?.timestamp).toBe(10);
  });

  it("preserves (timestamp, _id) ASC ordering across both feeds", () => {
    const activities = [
      progress("p1", "a1", 1),
      completedWithFile("c1", "a1", "/a.md", 6),
    ];
    const fileEvents = [
      toolResultWithFile("t1", "a1", "/x.md", 3),
      toolResultWithFile("t2", "a2", "/y.md", 8),
    ];
    const merged = mergeAgentFileEvents(activities, fileEvents);
    expect(merged.map((e) => e._id)).toEqual(["p1", "t1", "c1", "t2"]);
  });

  it("signature gating stays quiet across merges during pure streaming", () => {
    const activities = [
      progress("p1", "a1", 1),
      completedWithFile("c1", "a1", "/a.md", 2),
    ];
    const fileEvents = [toolResultWithFile("t1", "a1", "/live.md", 3)];
    const base = mergeAgentFileEvents(activities, fileEvents);
    // Next delta: refetched activity window (fresh objects, extra progress),
    // unchanged files window.
    const next = mergeAgentFileEvents(
      [...activities.map((e) => ({ ...e })), progress("p2", "a1", 4)],
      fileEvents,
    );
    expect(agentFilesSignature(next)).toBe(agentFilesSignature(base));
  });
});
