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

describe("orderByFirstSeen (newest-at-top)", () => {
  it("renders newest-first and ignores a live-updating sort field", () => {
    const first = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      keyOf,
      EMPTY_FIRST_SEEN_ORDER,
      true,
    );
    // c was seen last → it sits at the top; a (seen first) is at the bottom.
    expect(first.ordered.map(keyOf)).toEqual(["c", "b", "a"]);

    // The upstream feed re-orders the same items (e.g. because a recomputed
    // `startedAtMs` drifted) — the frozen order must ignore that.
    const second = orderByFirstSeen(
      [{ id: "c" }, { id: "a" }, { id: "b" }],
      keyOf,
      first.state,
      true,
    );
    expect(second.ordered.map(keyOf)).toEqual(["c", "b", "a"]);
  });

  it("prepends a newly-started row and keeps existing rows' relative order", () => {
    const first = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      keyOf,
      EMPTY_FIRST_SEEN_ORDER,
      true,
    );
    expect(first.ordered.map(keyOf)).toEqual(["c", "b", "a"]);

    // A new agent "d" starts; the feed also re-orders the survivors.
    const second = orderByFirstSeen(
      [{ id: "b" }, { id: "d" }, { id: "a" }, { id: "c" }],
      keyOf,
      first.state,
      true,
    );
    // d prepends at the top; c,b,a keep their prior relative order below it,
    // each shifted down by one.
    expect(second.ordered.map(keyOf)).toEqual(["d", "c", "b", "a"]);
  });

  it("prunes dropped keys so a re-activated key re-enters at the top", () => {
    const first = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      keyOf,
      EMPTY_FIRST_SEEN_ORDER,
      true,
    );
    // "a" finishes and leaves the running set.
    const second = orderByFirstSeen(
      [{ id: "b" }, { id: "c" }],
      keyOf,
      first.state,
      true,
    );
    expect(second.ordered.map(keyOf)).toEqual(["c", "b"]);
    expect(second.state.order.has("a")).toBe(false);
    // "a" comes back (send_input re-activation): treated as newest → top.
    const third = orderByFirstSeen(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      keyOf,
      second.state,
      true,
    );
    expect(third.ordered.map(keyOf)).toEqual(["a", "c", "b"]);
  });

  it("pins running activity rows even when startedAtMs drifts forward", () => {
    // Reproduces the sidebar bug: the activity window rolls, so the derived
    // startedAtMs for still-running rows keeps increasing. Sorting by that
    // field would reorder them; frozen first-seen order does not.
    const initial = [task("agent-1", 100), task("agent-2", 200)];
    const first = orderByFirstSeen(
      initial,
      activityRowId,
      EMPTY_FIRST_SEEN_ORDER,
      true,
    );
    // agent-2 started later → top; agent-1 stays below.
    expect(first.ordered.map(activityRowId)).toEqual(["agent-2", "agent-1"]);

    // agent-1's started event ages out; its startedAtMs is recomputed higher
    // than agent-2's and the feed order flips, but the pinned order does not.
    const drifted = [task("agent-2", 200), task("agent-1", 300)];
    const second = orderByFirstSeen(
      drifted,
      activityRowId,
      first.state,
      true,
    );
    expect(second.ordered.map(activityRowId)).toEqual(["agent-2", "agent-1"]);
  });

  it("keeps running-row order stable across type-a-query-then-clear", () => {
    // Models the sidebar's runningRows pipeline: first-seen indices are
    // assigned over the *unfiltered* running population and the search query
    // is applied afterward, for display only. This mirrors the ref threading
    // in LeftSidebarSections — the frozen state must survive a query-active
    // render so clearing the search doesn't reshuffle the list.
    const running = [task("agent-a", 100), task("agent-b", 200)];
    let state = EMPTY_FIRST_SEEN_ORDER;
    const step = (query: string | null) => {
      const { ordered, state: next } = orderByFirstSeen(
        running,
        activityRowId,
        state,
        true,
      );
      state = next;
      const visible = query
        ? ordered.filter((row) => activityRowId(row).includes(query))
        : ordered;
      return visible.map(activityRowId);
    };

    // No query: newest (agent-b) at the top.
    expect(step(null)).toEqual(["agent-b", "agent-a"]);
    // Type a query that only matches agent-a: agent-b is filtered from view
    // but must NOT be pruned from the frozen order map.
    expect(step("agent-a")).toEqual(["agent-a"]);
    expect(state.order.has("agent-b")).toBe(true);
    // Clear the query: order is identical to before the search — agent-b did
    // not re-enter as newly-seen and jump to the top.
    expect(step(null)).toEqual(["agent-b", "agent-a"]);
  });
});
