import { describe, expect, it, vi } from "vitest";
import { createStateContext, handleTask } from "../../../packages/runtime-kernel/tools/state.js";

describe("TaskCreate delegation controls", () => {
  it("forwards inherited depth and defaults parentTaskId from the current task", async () => {
    const createTask = vi.fn(async () => ({ threadId: "child-task" }));
    const ctx = createStateContext("state-root", {
      createTask,
      getTask: async () => null,
      cancelTask: async () => ({ canceled: false }),
    });

    const result = await handleTask(
      ctx,
      {
        action: "create",
        description: "Inspect codebase",
        prompt: "Check the imports",
        subagent_type: "explore",
      },
      {
        conversationId: "conv-1",
        deviceId: "device-1",
        requestId: "req-1",
        agentType: "general",
        taskId: "parent-task",
        taskDepth: 1,
        maxTaskDepth: 2,
        delegationAllowlist: ["explore"],
        storageMode: "local",
      },
    );

    expect(result.error).toBeUndefined();
    expect(createTask).toHaveBeenCalledWith({
      conversationId: "conv-1",
      description: "Inspect codebase",
      prompt: "Check the imports",
      agentType: "explore",
      taskDepth: 2,
      maxTaskDepth: 2,
      parentTaskId: "parent-task",
      systemPromptOverride: undefined,
      storageMode: "local",
    });
  });

  it("prefers the cloud task id when defaulting parentTaskId", async () => {
    const createTask = vi.fn(async () => ({ threadId: "child-task" }));
    const ctx = createStateContext("state-root", {
      createTask,
      getTask: async () => null,
      cancelTask: async () => ({ canceled: false }),
    });

    const result = await handleTask(
      ctx,
      {
        action: "create",
        description: "Inspect codebase",
        prompt: "Check the imports",
        subagent_type: "explore",
      },
      {
        conversationId: "conv-1",
        deviceId: "device-1",
        requestId: "req-1",
        agentType: "general",
        taskId: "parent-task",
        cloudTaskId: "cloud-parent-task",
        taskDepth: 1,
        maxTaskDepth: 2,
        delegationAllowlist: ["explore"],
        storageMode: "cloud",
      },
    );

    expect(result.error).toBeUndefined();
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: "cloud-parent-task",
        storageMode: "cloud",
      }),
    );
  });

  it("rejects child agent types outside the caller allowlist", async () => {
    const createTask = vi.fn(async () => ({ threadId: "child-task" }));
    const ctx = createStateContext("state-root", {
      createTask,
      getTask: async () => null,
      cancelTask: async () => ({ canceled: false }),
    });

    const result = await handleTask(
      ctx,
      {
        action: "create",
        description: "Open the browser",
        prompt: "Launch the app automation agent",
        subagent_type: "app",
      },
      {
        conversationId: "conv-1",
        deviceId: "device-1",
        requestId: "req-1",
        agentType: "general",
        taskDepth: 1,
        maxTaskDepth: 2,
        delegationAllowlist: ["explore"],
      },
    );

    expect(result.error).toContain("only create these subtask types: explore");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("defaults delegated task storage to local when the caller does not specify a storage mode", async () => {
    const createTask = vi.fn(async () => ({ threadId: "child-task" }));
    const ctx = createStateContext("state-root", {
      createTask,
      getTask: async () => null,
      cancelTask: async () => ({ canceled: false }),
    });

    const result = await handleTask(
      ctx,
      {
        action: "create",
        description: "Inspect codebase",
        prompt: "Check the imports",
        subagent_type: "explore",
      },
      {
        conversationId: "conv-1",
        deviceId: "device-1",
        requestId: "req-1",
        agentType: "general",
        taskDepth: 1,
        maxTaskDepth: 2,
        delegationAllowlist: ["explore"],
      },
    );

    expect(result.error).toBeUndefined();
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        storageMode: "local",
      }),
    );
  });

  it("rejects creates that would exceed the inherited depth budget", async () => {
    const createTask = vi.fn(async () => ({ threadId: "child-task" }));
    const ctx = createStateContext("state-root", {
      createTask,
      getTask: async () => null,
      cancelTask: async () => ({ canceled: false }),
    });

    const result = await handleTask(
      ctx,
      {
        action: "create",
        description: "Keep delegating",
        prompt: "This should be blocked",
        subagent_type: "explore",
      },
      {
        conversationId: "conv-1",
        deviceId: "device-1",
        requestId: "req-1",
        agentType: "general",
        taskDepth: 2,
        maxTaskDepth: 2,
        delegationAllowlist: ["explore"],
      },
    );

    expect(result.error).toContain("Task depth limit reached (2)");
    expect(createTask).not.toHaveBeenCalled();
  });
});
