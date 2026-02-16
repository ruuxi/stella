import { describe, it, expect } from "vitest";
import {
  extractStepsFromEvents,
  groupEventsIntoTurns,
  getCurrentRunningTool,
  extractTasksFromEvents,
  getRunningTasks,
  isToolRequest,
  isToolResult,
  isUserMessage,
  isAssistantMessage,
  isTaskStarted,
  isTaskCompleted,
  isTaskFailed,
  isTaskProgress,
  extractToolTitle,
  type EventRecord,
} from "./use-conversation-events";

// Helper to create mock events
const createEvent = (
  overrides: Partial<EventRecord> & { type: string }
): EventRecord => ({
  _id: `event-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  ...overrides,
});

const createUserMessage = (text: string): EventRecord =>
  createEvent({
    type: "user_message",
    payload: { text },
  });

const createAssistantMessage = (text: string): EventRecord =>
  createEvent({
    type: "assistant_message",
    payload: { text },
  });

const createToolRequest = (
  toolName: string,
  args?: Record<string, unknown>,
  requestId?: string
): EventRecord =>
  createEvent({
    type: "tool_request",
    requestId: requestId || `req-${Math.random().toString(36).slice(2)}`,
    payload: { toolName, args },
  });

const createToolResult = (
  toolName: string,
  requestId: string,
  error?: string
): EventRecord =>
  createEvent({
    type: "tool_result",
    requestId,
    payload: { toolName, error },
  });

describe("Type Guards", () => {
  it("isToolRequest identifies tool_request events", () => {
    const event = createToolRequest("read", { path: "/test.txt" });
    expect(isToolRequest(event)).toBe(true);
  });

  it("isToolRequest returns false for other events", () => {
    const event = createUserMessage("hello");
    expect(isToolRequest(event)).toBe(false);
  });

  it("isToolResult identifies tool_result events", () => {
    const event = createToolResult("read", "req-123");
    expect(isToolResult(event)).toBe(true);
  });

  it("isUserMessage identifies user messages", () => {
    const event = createUserMessage("hello");
    expect(isUserMessage(event)).toBe(true);
  });

  it("isAssistantMessage identifies assistant messages", () => {
    const event = createAssistantMessage("hi there");
    expect(isAssistantMessage(event)).toBe(true);
  });
});

describe("extractToolTitle", () => {
  it("extracts filename from read path", () => {
    const event = createToolRequest("read", { path: "/src/components/Button.tsx" });
    expect(extractToolTitle(event)).toBe("Button.tsx");
  });

  it("extracts pattern from grep", () => {
    const event = createToolRequest("grep", { pattern: "function handleClick" });
    expect(extractToolTitle(event)).toBe('"function handleClick"');
  });

  it("extracts hostname from webfetch", () => {
    const event = createToolRequest("webfetch", { url: "https://example.com/page" });
    expect(extractToolTitle(event)).toBe("example.com");
  });

  it("truncates long bash commands", () => {
    const longCommand = "npm install --save-dev typescript eslint prettier jest @types/node";
    const event = createToolRequest("bash", { command: longCommand });
    const title = extractToolTitle(event);
    expect(title.length).toBeLessThanOrEqual(43); // 40 + "..."
    expect(title).toContain("...");
  });
});

describe("extractStepsFromEvents", () => {
  it("returns empty array for empty events", () => {
    expect(extractStepsFromEvents([])).toEqual([]);
  });

  it("extracts running steps from tool requests without results", () => {
    const reqId = "req-123";
    const events = [createToolRequest("read", { path: "/test.txt" }, reqId)];
    const steps = extractStepsFromEvents(events);

    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe("read");
    expect(steps[0].status).toBe("running");
  });

  it("marks steps as completed when result exists", () => {
    const reqId = "req-456";
    const events = [
      createToolRequest("write", { path: "/out.txt" }, reqId),
      createToolResult("write", reqId),
    ];
    const steps = extractStepsFromEvents(events);

    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("completed");
  });

  it("marks steps as error when result has error", () => {
    const reqId = "req-789";
    const events = [
      createToolRequest("bash", { command: "invalid-cmd" }, reqId),
      createToolResult("bash", reqId, "Command not found"),
    ];
    const steps = extractStepsFromEvents(events);

    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("error");
  });

  it("handles multiple steps in order", () => {
    const events = [
      createToolRequest("read", { path: "/a.txt" }, "req-1"),
      createToolResult("read", "req-1"),
      createToolRequest("write", { path: "/b.txt" }, "req-2"),
      createToolResult("write", "req-2"),
      createToolRequest("grep", { pattern: "test" }, "req-3"),
    ];
    const steps = extractStepsFromEvents(events);

    expect(steps).toHaveLength(3);
    expect(steps[0].tool).toBe("read");
    expect(steps[0].status).toBe("completed");
    expect(steps[1].tool).toBe("write");
    expect(steps[1].status).toBe("completed");
    expect(steps[2].tool).toBe("grep");
    expect(steps[2].status).toBe("running");
  });
});

describe("groupEventsIntoTurns", () => {
  it("returns empty array for empty events", () => {
    expect(groupEventsIntoTurns([])).toEqual([]);
  });

  it("groups a simple user-assistant exchange", () => {
    const events = [createUserMessage("hello"), createAssistantMessage("hi there")];
    const turns = groupEventsIntoTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage.type).toBe("user_message");
    expect(turns[0].assistantMessage?.type).toBe("assistant_message");
  });

  it("includes tool events in the turn", () => {
    const reqId = "req-tool";
    const events = [
      createUserMessage("search for Button"),
      createToolRequest("grep", { pattern: "Button" }, reqId),
      createToolResult("grep", reqId),
      createAssistantMessage("Found it!"),
    ];
    const turns = groupEventsIntoTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].toolEvents).toHaveLength(2);
    expect(turns[0].steps).toHaveLength(1);
    expect(turns[0].steps[0].status).toBe("completed");
  });

  it("creates multiple turns for multiple user messages", () => {
    const events = [
      createUserMessage("first question"),
      createAssistantMessage("first answer"),
      createUserMessage("second question"),
      createAssistantMessage("second answer"),
    ];
    const turns = groupEventsIntoTurns(events);

    expect(turns).toHaveLength(2);
  });

  it("handles turn with tools but no assistant message yet", () => {
    const events = [
      createUserMessage("do something"),
      createToolRequest("read", { path: "/test.txt" }, "req-1"),
    ];
    const turns = groupEventsIntoTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].assistantMessage).toBeUndefined();
    expect(turns[0].steps).toHaveLength(1);
    expect(turns[0].steps[0].status).toBe("running");
  });
});

describe("getCurrentRunningTool", () => {
  it("returns undefined for empty events", () => {
    expect(getCurrentRunningTool([])).toBeUndefined();
  });

  it("returns undefined when all tools are completed", () => {
    const events = [
      createToolRequest("read", { path: "/a.txt" }, "req-1"),
      createToolResult("read", "req-1"),
    ];
    expect(getCurrentRunningTool(events)).toBeUndefined();
  });

  it("returns the running tool name", () => {
    const events = [
      createToolRequest("read", { path: "/a.txt" }, "req-1"),
      createToolResult("read", "req-1"),
      createToolRequest("write", { path: "/b.txt" }, "req-2"),
    ];
    expect(getCurrentRunningTool(events)).toBe("write");
  });
});

describe("extractTasksFromEvents", () => {
  it("returns empty array for no events", () => {
    expect(extractTasksFromEvents([])).toEqual([]);
  });

  it("creates running tasks from task_started events", () => {
    const events = [
      createEvent({
        type: "task_started",
        payload: { taskId: "t1", description: "Research", agentType: "explore" },
      }),
    ];
    const tasks = extractTasksFromEvents(events);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "t1",
      description: "Research",
      agentType: "explore",
      status: "running",
    });
  });

  it("marks tasks as completed", () => {
    const events = [
      createEvent({
        type: "task_started",
        payload: { taskId: "t1", description: "Work", agentType: "general" },
      }),
      createEvent({
        type: "task_completed",
        payload: { taskId: "t1", result: "Done" },
      }),
    ];
    const tasks = extractTasksFromEvents(events);
    expect(tasks[0].status).toBe("completed");
  });

  it("marks tasks as error on failure", () => {
    const events = [
      createEvent({
        type: "task_started",
        payload: { taskId: "t1", description: "Work", agentType: "general" },
      }),
      createEvent({
        type: "task_failed",
        payload: { taskId: "t1", error: "timeout" },
      }),
    ];
    const tasks = extractTasksFromEvents(events);
    expect(tasks[0].status).toBe("error");
  });

  it("attaches statusText from task_progress", () => {
    const events = [
      createEvent({
        type: "task_started",
        payload: { taskId: "t1", description: "Work", agentType: "general" },
      }),
      createEvent({
        type: "task_progress",
        payload: { taskId: "t1", statusText: "50% done" },
      }),
    ];
    const tasks = extractTasksFromEvents(events);
    expect(tasks[0].statusText).toBe("50% done");
  });
});

describe("getRunningTasks", () => {
  it("returns only running tasks", () => {
    const events = [
      createEvent({
        type: "task_started",
        payload: { taskId: "t1", description: "A", agentType: "explore" },
      }),
      createEvent({
        type: "task_started",
        payload: { taskId: "t2", description: "B", agentType: "general" },
      }),
      createEvent({
        type: "task_completed",
        payload: { taskId: "t1" },
      }),
    ];
    const running = getRunningTasks(events);
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe("t2");
  });
});

describe("type guards - tasks", () => {
  it("isTaskStarted identifies task_started events", () => {
    expect(
      isTaskStarted(
        createEvent({
          type: "task_started",
          payload: { taskId: "t1", description: "d", agentType: "general" },
        }),
      ),
    ).toBe(true);
    expect(
      isTaskStarted(createEvent({ type: "task_started", payload: {} })),
    ).toBe(false);
  });

  it("isTaskCompleted identifies task_completed events", () => {
    expect(
      isTaskCompleted(
        createEvent({ type: "task_completed", payload: { taskId: "t1" } }),
      ),
    ).toBe(true);
    expect(
      isTaskCompleted(createEvent({ type: "task_completed" })),
    ).toBe(false);
  });

  it("isTaskFailed identifies task_failed events", () => {
    expect(
      isTaskFailed(
        createEvent({ type: "task_failed", payload: { taskId: "t1" } }),
      ),
    ).toBe(true);
  });

  it("isTaskProgress identifies task_progress events", () => {
    expect(
      isTaskProgress(
        createEvent({
          type: "task_progress",
          payload: { taskId: "t1", statusText: "Working" },
        }),
      ),
    ).toBe(true);
    expect(
      isTaskProgress(
        createEvent({ type: "task_progress", payload: { taskId: "t1" } }),
      ),
    ).toBe(false);
  });
});

describe("extractToolTitle - additional cases", () => {
  it("extracts filename from Edit tool", () => {
    const event = createToolRequest("edit", { path: "/src/foo/bar.ts" });
    expect(extractToolTitle(event)).toBe("bar.ts");
  });

  it("returns default for Write without path", () => {
    const event = createToolRequest("write", {});
    expect(extractToolTitle(event)).toBe("Writing file");
  });

  it("returns default for Glob without pattern", () => {
    const event = createToolRequest("glob", {});
    expect(extractToolTitle(event)).toBe("Finding files");
  });

  it("returns default for Bash without command", () => {
    const event = createToolRequest("bash", {});
    expect(extractToolTitle(event)).toBe("Running command");
  });

  it("extracts description from Task tool", () => {
    const event = createToolRequest("task", {
      description: "Explore the codebase",
    });
    expect(extractToolTitle(event)).toBe("Explore the codebase");
  });

  it("returns toolName for unknown tools", () => {
    const event = createToolRequest("CustomTool", {});
    expect(extractToolTitle(event)).toBe("CustomTool");
  });

  it("returns empty string for non-tool events", () => {
    expect(extractToolTitle(createUserMessage("hi"))).toBe("");
  });
});

describe("groupEventsIntoTurns - standalone assistant", () => {
  it("handles standalone assistant message (no user turn)", () => {
    const events = [createAssistantMessage("Welcome")];
    const turns = groupEventsIntoTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage._id).toMatch(/^synthetic-/);
  });
});

describe("Integration: Full conversation flow", () => {
  it("processes a complete conversation with multiple tool calls", () => {
    const events = [
      createUserMessage("Find all TypeScript files and show the Button component"),
      createToolRequest("glob", { pattern: "**/*.tsx" }, "req-glob"),
      createToolResult("glob", "req-glob"),
      createToolRequest("read", { path: "/src/Button.tsx" }, "req-read"),
      createToolResult("read", "req-read"),
      createAssistantMessage("Here's the Button component..."),
      createUserMessage("Now update it"),
      createToolRequest("write", { path: "/src/Button.tsx" }, "req-write"),
    ];

    const turns = groupEventsIntoTurns(events);
    expect(turns).toHaveLength(2);

    // First turn: 2 completed tools
    expect(turns[0].steps).toHaveLength(2);
    expect(turns[0].steps.every((s) => s.status === "completed")).toBe(true);

    // Second turn: 1 running tool
    expect(turns[1].steps).toHaveLength(1);
    expect(turns[1].steps[0].status).toBe("running");

    // Current running tool
    expect(getCurrentRunningTool(events)).toBe("write");
  });
});
