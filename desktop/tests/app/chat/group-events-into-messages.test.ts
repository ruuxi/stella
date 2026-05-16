import { describe, expect, it } from "vitest";
import type { EventRecord } from "../../../../runtime/contracts/local-chat";
import { groupEventsIntoMessages } from "@/app/chat/lib/group-events-into-messages";

const event = (overrides: Partial<EventRecord>): EventRecord => ({
  _id: overrides._id ?? "",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "user_message",
  ...overrides,
});

describe("groupEventsIntoMessages", () => {
  it("attaches turn tools to the first assistant of the turn", () => {
    const events: EventRecord[] = [
      event({ _id: "u1", type: "user_message", timestamp: 1 }),
      event({ _id: "a1", type: "assistant_message", timestamp: 2 }),
      event({
        _id: "t1",
        type: "tool_request",
        timestamp: 3,
        payload: { toolName: "exec_command", args: { cmd: "ls" } },
      }),
      event({
        _id: "t2",
        type: "tool_result",
        timestamp: 4,
        payload: { toolName: "exec_command" },
      }),
      event({
        _id: "ac1",
        type: "agent-completed",
        timestamp: 5,
        payload: { agentId: "a" },
      }),
      event({ _id: "u2", type: "user_message", timestamp: 6 }),
      event({
        _id: "t3",
        type: "tool_request",
        timestamp: 7,
        payload: { toolName: "askQuestion", args: {} },
      }),
    ];
    const messages = groupEventsIntoMessages(events);
    expect(messages.map((m) => m._id)).toEqual(["u1", "a1", "u2"]);
    expect(messages[0]!.toolEvents).toEqual([]);
    expect(messages[1]!.toolEvents.map((e) => e._id)).toEqual(["t1", "t2", "ac1"]);
    // No assistant in turn 2 — tool falls back to u2 anchor (lossless).
    expect(messages[2]!.toolEvents.map((e) => e._id)).toEqual(["t3"]);
  });

  it("attaches pre-reply tools to the assistant when one fires later in the turn", () => {
    // Regression: orchestrator emits the tool BEFORE its reply text
    // (common for `image_gen`, `html`, `Schedule`). Inline artifact
    // derivation runs on assistant rows — without turn-anchor grouping
    // these tools would land on the user_message and the assistant row
    // would render with no artifact card.
    const events: EventRecord[] = [
      event({ _id: "u1", type: "user_message", timestamp: 1 }),
      event({
        _id: "tool-req",
        type: "tool_request",
        timestamp: 2,
        payload: { toolName: "image_gen" },
      }),
      event({
        _id: "tool-res",
        type: "tool_result",
        timestamp: 3,
        payload: { toolName: "image_gen" },
      }),
      event({ _id: "a1", type: "assistant_message", timestamp: 4 }),
    ];
    const messages = groupEventsIntoMessages(events);
    expect(messages[0]!.toolEvents).toEqual([]);
    expect(messages[1]!.toolEvents.map((e) => e._id)).toEqual([
      "tool-req",
      "tool-res",
    ]);
  });

  it("keeps secondary assistants in the turn (agent terminal notices) with empty toolEvents", () => {
    const events: EventRecord[] = [
      event({ _id: "u1", type: "user_message", timestamp: 1 }),
      event({ _id: "a1", type: "assistant_message", timestamp: 2 }),
      event({
        _id: "tool-res",
        type: "tool_result",
        timestamp: 3,
        payload: { toolName: "spawn_agent" },
      }),
      event({ _id: "a2", type: "assistant_message", timestamp: 4 }),
    ];
    const messages = groupEventsIntoMessages(events);
    expect(messages.map((m) => m._id)).toEqual(["u1", "a1", "a2"]);
    expect(messages[1]!.toolEvents.map((e) => e._id)).toEqual(["tool-res"]);
    expect(messages[2]!.toolEvents).toEqual([]);
  });

  it("drops tool events that precede the first message in the window", () => {
    const events: EventRecord[] = [
      event({
        _id: "t-orphan",
        type: "tool_request",
        timestamp: 1,
        payload: { toolName: "exec_command" },
      }),
      event({ _id: "u1", type: "user_message", timestamp: 2 }),
    ];
    const messages = groupEventsIntoMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]!._id).toBe("u1");
    expect(messages[0]!.toolEvents).toEqual([]);
  });

  it("skips event types that are not chat messages or turn decorations", () => {
    const events: EventRecord[] = [
      event({ _id: "u1", type: "user_message", timestamp: 1 }),
      event({
        _id: "ap1",
        type: "agent-progress",
        timestamp: 2,
        payload: { agentId: "a", statusText: "working" },
      }),
      event({
        _id: "as1",
        type: "agent-started",
        timestamp: 3,
        payload: { agentId: "a" },
      }),
      event({ _id: "a1", type: "assistant_message", timestamp: 4 }),
    ];
    const messages = groupEventsIntoMessages(events);
    expect(messages.map((m) => m._id)).toEqual(["u1", "a1"]);
    expect(messages[0]!.toolEvents).toEqual([]);
    expect(messages[1]!.toolEvents).toEqual([]);
  });
});
