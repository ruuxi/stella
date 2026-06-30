import { describe, expect, it } from "vitest";
import { getBackgroundWork } from "@/features/chat/hooks/use-event-rows";
import type { EventRecord } from "@/features/chat/lib/event-transforms";

/**
 * `agent-started` lifecycle event as persisted into a turn's `toolEvents`.
 * A fresh `spawn_agent` falls `statusText` back to the spawn `description`
 * (so they match); a `send_input` re-activation carries the thread's ORIGINAL
 * `description` but the follow-up's own message on `statusText`.
 */
const started = (
  agentId: string,
  description: string,
  opts: {
    statusText?: string;
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
    },
  }) as unknown as EventRecord;

describe("getBackgroundWork spawn vs send_input follow-up", () => {
  it("reads a fresh spawn as a non-follow-up card titled by its description", () => {
    // Spawn: statusText falls back to the spawn description.
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
    // statusText is the follow-up's own message.
    const work = getBackgroundWork([
      started("thread-a", "Research flights to Tokyo", {
        statusText: "Also check return flights on the 14th",
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

  it("does not flag a follow-up when statusText equals the description (plain spawn, only whitespace differs)", () => {
    const work = getBackgroundWork([
      started("thread-a", "Build the report", {
        statusText: "  Build the report  ",
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
      }),
    ]);
    expect(work).toBeUndefined();
  });

  it("keeps spawn and follow-up distinct within one turn (mixed start events)", () => {
    const work = getBackgroundWork([
      started("thread-a", "Spawned task", { statusText: "Spawned task" }),
      started("thread-b", "Original goal", {
        statusText: "Follow-up update for B",
        timestamp: 50,
      }),
    ]);
    expect(work?.threadIds).toEqual(["thread-a", "thread-b"]);
    expect(work?.followUpThreadIds).toEqual(["thread-b"]);
    expect(work?.statusTexts["thread-b"]).toBe("Follow-up update for B");
    expect(work?.statusTexts["thread-a"]).toBeUndefined();
  });
});
