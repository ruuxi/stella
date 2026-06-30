import { describe, expect, it } from "vitest";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  agentFilesSignature,
  deriveAgentFilesMap,
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
