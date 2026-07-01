import { describe, expect, it } from "vitest";
import {
  EMPTY_FIRST_SEEN_ORDER,
  orderByFirstSeen,
  type ActivityRow,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";

const keyOf = (item: { id: string }): string => item.id;

const task = (id: string, startedAtMs: number): ActivityRow => ({
  kind: "task",
  task: {
    id,
    description: id,
    agentType: "general",
    status: "running",
    statusText: undefined,
    startedAtMs,
    completedAtMs: undefined,
    lastUpdatedAtMs: startedAtMs,
  } as TaskItem,
});

const activityRowId = (row: ActivityRow): string =>
  row.kind === "task" ? row.task.id : row.group.groupKey;

describe("orderByFirstSeen", () => {
  it("keeps first-seen order regardless of a live-updating sort field", () => {
    const first = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      keyOf,
      EMPTY_FIRST_SEEN_ORDER,
    );
    expect(first.ordered.map(keyOf)).toEqual(["a", "b", "c"]);

    // The upstream feed re-orders the same items (e.g. because a recomputed
    // `startedAtMs` drifted) — the frozen order must ignore that.
    const second = orderByFirstSeen(
      [{ id: "c" }, { id: "a" }, { id: "b" }],
      keyOf,
      first.state,
    );
    expect(second.ordered.map(keyOf)).toEqual(["a", "b", "c"]);
  });

  it("appends newly-seen items at the end without moving existing ones", () => {
    const first = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }],
      keyOf,
      EMPTY_FIRST_SEEN_ORDER,
    );
    const second = orderByFirstSeen(
      [{ id: "b" }, { id: "d" }, { id: "a" }, { id: "c" }],
      keyOf,
      first.state,
    );
    // a,b hold their slots; c,d appear after them in encounter order.
    expect(second.ordered.map(keyOf)).toEqual(["a", "b", "d", "c"]);
  });

  it("prunes dropped keys so a re-activated key re-enters at the end", () => {
    const first = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      keyOf,
      EMPTY_FIRST_SEEN_ORDER,
    );
    // "a" finishes and leaves the running set.
    const second = orderByFirstSeen(
      [{ id: "b" }, { id: "c" }],
      keyOf,
      first.state,
    );
    expect(second.ordered.map(keyOf)).toEqual(["b", "c"]);
    expect(second.state.order.has("a")).toBe(false);
    // "a" comes back (send_input re-activation): it lands after b,c.
    const third = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      keyOf,
      second.state,
    );
    expect(third.ordered.map(keyOf)).toEqual(["b", "c", "a"]);
  });

  it("pins running activity rows even when startedAtMs drifts forward", () => {
    // Reproduces the sidebar bug: the activity window rolls, so the derived
    // startedAtMs for still-running rows keeps increasing. Newest-first
    // sorting would reorder them; first-seen order does not.
    const initial = [task("agent-1", 100), task("agent-2", 200)];
    const first = orderByFirstSeen(
      initial,
      activityRowId,
      EMPTY_FIRST_SEEN_ORDER,
    );
    expect(first.ordered.map(activityRowId)).toEqual(["agent-1", "agent-2"]);

    // agent-1's started event ages out; its startedAtMs is recomputed higher
    // than agent-2's. The feed order flips, but the pinned order does not.
    const drifted = [task("agent-2", 200), task("agent-1", 300)];
    const second = orderByFirstSeen(drifted, activityRowId, first.state);
    expect(second.ordered.map(activityRowId)).toEqual(["agent-1", "agent-2"]);
  });
});
