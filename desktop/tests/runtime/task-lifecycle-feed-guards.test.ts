import { describe, expect, it } from "vitest";
import {
  AGENT_STREAM_EVENT_TYPES,
  shouldIgnoreTerminalTaskFeedEvent,
} from "../../src/shared/contracts/agent-runtime";

describe("shouldIgnoreTerminalTaskFeedEvent", () => {
  it("ignores late progress and reasoning once a task is terminal", () => {
    expect(
      shouldIgnoreTerminalTaskFeedEvent({
        currentStatus: "completed",
        eventType: AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreTerminalTaskFeedEvent({
        currentStatus: "error",
        eventType: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
      }),
    ).toBe(true);
  });

  it("allows fresh starts and terminal follow-up events for terminal tasks", () => {
    expect(
      shouldIgnoreTerminalTaskFeedEvent({
        currentStatus: "canceled",
        eventType: AGENT_STREAM_EVENT_TYPES.AGENT_STARTED,
      }),
    ).toBe(false);
    expect(
      shouldIgnoreTerminalTaskFeedEvent({
        currentStatus: "completed",
        eventType: AGENT_STREAM_EVENT_TYPES.AGENT_FAILED,
      }),
    ).toBe(false);
  });

  it("does not ignore non-terminal tasks", () => {
    expect(
      shouldIgnoreTerminalTaskFeedEvent({
        currentStatus: "running",
        eventType: AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS,
      }),
    ).toBe(false);
    expect(
      shouldIgnoreTerminalTaskFeedEvent({
        currentStatus: undefined,
        eventType: AGENT_STREAM_EVENT_TYPES.AGENT_REASONING,
      }),
    ).toBe(false);
  });
});
