import { describe, expect, it } from "vitest";
import {
  derivePausedThreadIds,
  getBackgroundWork,
  getBackgroundWorks,
} from "@/features/chat/hooks/use-event-rows";
import type { EventRecord } from "@/features/chat/lib/event-transforms";

/**
 * `agent-started` lifecycle event as persisted into a turn's `toolEvents`.
 * A fresh `spawn_agent` leaves `isFollowUp` unset; a `send_input` re-activation
 * carries the thread's ORIGINAL `description` but stamps `isFollowUp: true` and
 * puts the follow-up's own message on `statusText`. The card keys its follow-up
 * variant off the explicit `isFollowUp` flag (not a description/statusText
 * mismatch), so the follow-up's text becomes the title while the spawn card
 * stays put.
 */
const started = (
  agentId: string,
  description: string,
  opts: {
    statusText?: string;
    isFollowUp?: boolean;
    agentType?: string;
    timestamp?: number;
  } = {},
): EventRecord =>
  ({
    _id: `started:${agentId}:${opts.timestamp ?? 1}`,
    timestamp: opts.timestamp ?? 1,
    type: "agent-started",
    payload: {
      agentId,
      description,
      agentType: opts.agentType ?? "general",
      ...(opts.statusText !== undefined ? { statusText: opts.statusText } : {}),
      ...(opts.isFollowUp ? { isFollowUp: true } : {}),
    },
  }) as unknown as EventRecord;

describe("getBackgroundWork spawn vs send_input follow-up", () => {
  it("reads a fresh spawn as a non-follow-up card titled by its description", () => {
    // Spawn: no isFollowUp flag; statusText mirrors the spawn description.
    const work = getBackgroundWork([
      started("thread-a", "Research flights to Tokyo", {
        statusText: "Research flights to Tokyo",
      }),
    ]);
    expect(work).toBeDefined();
    expect(work?.threadIds).toEqual(["thread-a"]);
    expect(work?.descriptions["thread-a"]).toBe("Research flights to Tokyo");
    expect(work?.followUpThreadIds).toEqual([]);
    expect(work?.statusTexts["thread-a"]).toBeUndefined();
  });

  it("reads a send_input re-activation as a follow-up carrying the follow-up text, not the stale spawn description", () => {
    // send_input to the SAME thread: description is the original spawn summary,
    // statusText is the follow-up's own message, and isFollowUp is set.
    const work = getBackgroundWork([
      started("thread-a", "Research flights to Tokyo", {
        statusText: "Also check return flights on the 14th",
        isFollowUp: true,
        timestamp: 200,
      }),
    ]);
    expect(work).toBeDefined();
    expect(work?.followUpThreadIds).toEqual(["thread-a"]);
    // The follow-up's own message surfaces (NOT the original spawn description).
    expect(work?.statusTexts["thread-a"]).toBe(
      "Also check return flights on the 14th",
    );
    // Original description is still captured for fallback, but is no longer the
    // title the card shows for a follow-up.
    expect(work?.descriptions["thread-a"]).toBe("Research flights to Tokyo");
  });

  it("renders a follow-up as a follow-up EVEN when its text is identical to the spawn description (the case the heuristic missed)", () => {
    // The old `statusText !== description` heuristic wrongly read this as a
    // spawn; the explicit flag fixes it.
    const work = getBackgroundWork([
      started("thread-a", "Build the report", {
        statusText: "Build the report",
        isFollowUp: true,
      }),
    ]);
    expect(work?.followUpThreadIds).toEqual(["thread-a"]);
    expect(work?.statusTexts["thread-a"]).toBe("Build the report");
  });

  it("does not flag a spawn as a follow-up even when statusText differs from the description", () => {
    // Without the explicit flag, a differing statusText no longer implies a
    // follow-up — the flag is the sole signal.
    const work = getBackgroundWork([
      started("thread-a", "Original goal", {
        statusText: "some in-flight status",
      }),
    ]);
    expect(work?.followUpThreadIds).toEqual([]);
    expect(work?.statusTexts["thread-a"]).toBeUndefined();
  });

  it("excludes orchestrator-reserved builtin agents from the card entirely", () => {
    const work = getBackgroundWork([
      started("schedule-thread", "Schedule a reminder", {
        agentType: "schedule",
        statusText: "tweak the time",
        isFollowUp: true,
      }),
    ]);
    expect(work).toBeUndefined();
  });

  it("returns separate cards for a spawn and follow-up within one turn", () => {
    const works = getBackgroundWorks([
      started("thread-a", "Spawned task", { statusText: "Spawned task" }),
      started("thread-b", "Original goal", {
        statusText: "Follow-up update for B",
        isFollowUp: true,
        timestamp: 50,
      }),
    ]);
    expect(works).toHaveLength(2);
    expect(works[0]?.threadIds).toEqual(["thread-a"]);
    expect(works[0]?.followUpThreadIds).toEqual([]);
    expect(works[1]?.threadIds).toEqual(["thread-b"]);
    expect(works[1]?.followUpThreadIds).toEqual(["thread-b"]);
    expect(works[1]?.statusTexts["thread-b"]).toBe("Follow-up update for B");
  });
});

describe("derivePausedThreadIds — paused state for the inline cards", () => {
  it("flags a thread whose agent-canceled (pause_agent) postdates this card's spawn", () => {
    const paused = derivePausedThreadIds(
      ["thread-a"],
      { "thread-a": 100 },
      new Map(),
      new Map([["thread-a", 250]]),
    );
    expect(paused).toEqual(["thread-a"]);
  });

  it("ignores a cancel from a PREVIOUS run (before this card's spawn)", () => {
    // Thread paused earlier, then re-activated via send_input: the follow-up
    // card (spawn 300) must read as active again — labels + shimmer return.
    const paused = derivePausedThreadIds(
      ["thread-a"],
      { "thread-a": 300 },
      new Map(),
      new Map([["thread-a", 250]]),
    );
    expect(paused).toEqual([]);
  });

  it("completion after the cancel wins — a finished thread is settled, not Paused", () => {
    const paused = derivePausedThreadIds(
      ["thread-a"],
      { "thread-a": 100 },
      new Map([["thread-a", 400]]),
      new Map([["thread-a", 250]]),
    );
    expect(paused).toEqual([]);
  });

  it("pause after a completion (thread revived then paused) reads as Paused", () => {
    const paused = derivePausedThreadIds(
      ["thread-a"],
      { "thread-a": 100 },
      new Map([["thread-a", 200]]),
      new Map([["thread-a", 500]]),
    );
    expect(paused).toEqual(["thread-a"]);
  });

  it("only flags threads with a cancel signal at all", () => {
    const paused = derivePausedThreadIds(
      ["thread-a", "thread-b"],
      { "thread-a": 100, "thread-b": 100 },
      new Map(),
      new Map([["thread-b", 150]]),
    );
    expect(paused).toEqual(["thread-b"]);
  });
});
