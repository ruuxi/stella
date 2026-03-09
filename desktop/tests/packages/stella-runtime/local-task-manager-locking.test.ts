import { describe, expect, it, vi } from "vitest";
import { LocalTaskManager, type LocalTaskManagerAgentContext } from "@stella/stella-runtime/tasks";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const buildAgentContext = (): LocalTaskManagerAgentContext => ({
  systemPrompt: "system",
  dynamicContext: "",
  maxTaskDepth: 4,
  defaultSkills: [],
  skillIds: [],
});

describe("LocalTaskManager Windows fs lock scoping", () => {
  it("does not collapse Bash drive-letter paths into the global lock", async () => {
    const firstToolStarted = createDeferred();
    const releaseFirstTool = createDeferred();
    const toolExecutor = vi.fn(async (toolName: string) => {
      if (toolName === "Bash") {
        firstToolStarted.resolve();
        await releaseFirstTool.promise;
        return { result: "bash-ok" };
      }
      return { result: "edit-ok" };
    });

    const manager = new LocalTaskManager({
      maxConcurrent: 2,
      onTaskEvent: vi.fn(),
      fetchAgentContext: vi.fn().mockResolvedValue(buildAgentContext()),
      runSubagent: vi.fn(async ({ taskDescription, toolExecutor }) => {
        if (taskDescription === "task-1") {
          await toolExecutor(
            "Bash",
            { command: 'type "C:\\repo\\notes.txt"' },
            { conversationId: "conv-1", deviceId: "device-1", requestId: "req-1" },
          );
          return { runId: "run-1", result: "done-1" };
        }
        await toolExecutor(
          "Edit",
          { file_path: "C:\\other\\todo.txt" },
          { conversationId: "conv-1", deviceId: "device-1", requestId: "req-2" },
        );
        return { runId: "run-2", result: "done-2" };
      }),
      toolExecutor,
      createCloudTaskRecord: vi.fn(),
      completeCloudTaskRecord: vi.fn(),
      getCloudTaskRecord: vi.fn(),
      cancelCloudTaskRecord: vi.fn(),
    });

    await manager.createTask({
      conversationId: "conv-1",
      description: "task-1",
      prompt: "run bash",
      agentType: "general",
      storageMode: "local",
    });
    await manager.createTask({
      conversationId: "conv-1",
      description: "task-2",
      prompt: "edit file",
      agentType: "general",
      storageMode: "local",
    });

    await firstToolStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toolExecutor).toHaveBeenCalledWith(
      "Edit",
      expect.objectContaining({ file_path: "C:\\other\\todo.txt" }),
      expect.any(Object),
      undefined,
    );

    releaseFirstTool.resolve();
  });

  it("does not collapse SkillBash .\\ relative paths into the global lock", async () => {
    const firstToolStarted = createDeferred();
    const releaseFirstTool = createDeferred();
    const toolExecutor = vi.fn(async (toolName: string) => {
      if (toolName === "SkillBash") {
        firstToolStarted.resolve();
        await releaseFirstTool.promise;
        return { result: "skillbash-ok" };
      }
      return { result: "edit-ok" };
    });

    const manager = new LocalTaskManager({
      maxConcurrent: 2,
      onTaskEvent: vi.fn(),
      fetchAgentContext: vi.fn().mockResolvedValue(buildAgentContext()),
      runSubagent: vi.fn(async ({ taskDescription, toolExecutor }) => {
        if (taskDescription === "task-1") {
          await toolExecutor(
            "SkillBash",
            {
              command: ".\\scripts\\sync.ps1",
              cwd: "C:\\repo",
            },
            { conversationId: "conv-1", deviceId: "device-1", requestId: "req-1" },
          );
          return { runId: "run-1", result: "done-1" };
        }
        await toolExecutor(
          "Edit",
          { file_path: "C:\\other\\todo.txt" },
          { conversationId: "conv-1", deviceId: "device-1", requestId: "req-2" },
        );
        return { runId: "run-2", result: "done-2" };
      }),
      toolExecutor,
      createCloudTaskRecord: vi.fn(),
      completeCloudTaskRecord: vi.fn(),
      getCloudTaskRecord: vi.fn(),
      cancelCloudTaskRecord: vi.fn(),
    });

    await manager.createTask({
      conversationId: "conv-1",
      description: "task-1",
      prompt: "run skill bash",
      agentType: "general",
      storageMode: "local",
    });
    await manager.createTask({
      conversationId: "conv-1",
      description: "task-2",
      prompt: "edit file",
      agentType: "general",
      storageMode: "local",
    });

    await firstToolStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toolExecutor).toHaveBeenCalledWith(
      "Edit",
      expect.objectContaining({ file_path: "C:\\other\\todo.txt" }),
      expect.any(Object),
      undefined,
    );

    releaseFirstTool.resolve();
  });
});
