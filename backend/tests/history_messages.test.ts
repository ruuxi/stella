import { describe, expect, test } from "bun:test";
import { eventsToHistoryMessages } from "../convex/agent/history_messages";

const baseEvent = {
  _id: "event_1",
  _creationTime: 0,
  conversationId: "conversation_1",
  timestamp: 0,
  payload: {},
};

describe("history message formatting", () => {
  test("replays user and assistant messages", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_user",
        type: "user_message",
        payload: { text: "Open Microsoft Word" },
      },
      {
        ...baseEvent,
        _id: "event_assistant",
        type: "assistant_message",
        payload: { text: "Trying that now." },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Open Microsoft Word");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toContain("Trying that now.");
  });

  test("replays tool calls and tool results", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_tool_req",
        requestId: "req_123",
        type: "tool_request",
        payload: {
          toolName: "Bash",
          args: { command: "start winword" },
          agentType: "general",
        },
      },
      {
        ...baseEvent,
        _id: "event_tool_res",
        requestId: "req_123",
        type: "tool_result",
        payload: {
          toolName: "Bash",
          result: "Command executed successfully.",
        },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
    });
    expect(messages[0]?.content).toContain("[Tool call] Bash");
    expect(messages[0]?.content).toContain("request_id: req_123");
    expect(messages[0]?.content).toContain("start winword");

    expect(messages[1]).toMatchObject({
      role: "user",
    });
    expect(messages[1]?.content).toContain("[Tool result] Bash");
    expect(messages[1]?.content).toContain("request_id: req_123");
    expect(messages[1]?.content).toContain("Command executed successfully.");
  });

  test("inserts synthetic tool result when a call is left unresolved", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_tool_req_unresolved",
        requestId: "req_missing",
        type: "tool_request",
        payload: {
          toolName: "Bash",
          args: { command: "start winword" },
          agentType: "general",
        },
      },
      {
        ...baseEvent,
        _id: "event_next_user",
        type: "user_message",
        payload: { text: "Any update?" },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toContain("[Tool result] Bash");
    expect(messages[1]?.content).toContain("request_id: req_missing");
    expect(messages[1]?.content).toContain("No result provided");
    expect(messages[2]?.role).toBe("user");
    expect(messages[2]?.content).toContain("Any update?");
  });

  test("replays task lifecycle events", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_task_started",
        type: "task_started",
        payload: {
          taskId: "task_1",
          description: "Open Microsoft Word",
          agentType: "general",
        },
      },
      {
        ...baseEvent,
        _id: "event_task_completed",
        type: "task_completed",
        payload: {
          taskId: "task_1",
          result: "Word launched.",
        },
      },
      {
        ...baseEvent,
        _id: "event_task_failed",
        type: "task_failed",
        payload: {
          taskId: "task_2",
          error: "Tool timed out",
        },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toContain("[Task started] Open Microsoft Word");
    expect(messages[1]?.content).toContain("[Task completed]");
    expect(messages[2]?.content).toContain("[Task failed]");
  });

  test("ignores unrelated internal events", () => {
    const events = [
      {
        ...baseEvent,
        _id: "event_internal",
        type: "screen_event",
        payload: { text: "something" },
      },
      {
        ...baseEvent,
        _id: "event_user_valid",
        type: "user_message",
        payload: { text: "Hello" },
      },
    ] as unknown[];

    const messages = eventsToHistoryMessages(events).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Hello");
  });
});
