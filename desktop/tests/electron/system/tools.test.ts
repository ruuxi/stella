import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import path from "path";
import { createToolHost, type ToolContext } from "../../../electron/core/runtime/tools/host.js";
import type { TaskToolRequest } from "../../../electron/core/runtime/tools/types.js";

// Mock fs and spawn
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    access: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
  },
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("Tools Module - Unit Tests", () => {
  let toolHost: ReturnType<typeof createToolHost>;
  const mockStellaHome = "/tmp/test-stella-home";
  const testContext: ToolContext = {
    conversationId: "test-conv",
    deviceId: "test-device",
    requestId: "test-req",
    agentType: "general",
  };

  beforeEach(() => {
    toolHost = createToolHost({
      stellaHomePath: mockStellaHome,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Tool Registry", () => {
    it("returns unknown tool for removed SqliteQuery handler", async () => {
      const result = await toolHost.executeTool(
        "SqliteQuery",
        {
          database_path: "/tmp/test.db",
          query: "SELECT * FROM test",
        },
        testContext
      );

      expect(result.error).toContain("Unknown tool: SqliteQuery");
    });

    it("returns unknown tool for unregistered tool names", async () => {
      const result = await toolHost.executeTool(
        "NotARealTool",
        {
          value: "irrelevant",
        },
        testContext
      );
      expect(result.error).toContain("Unknown tool: NotARealTool");
    });
  });

  describe("Path Expansion", () => {
    it("should expand ~ to home directory", async () => {
      const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> };
      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("file content");

      await toolHost.executeTool(
        "Read",
        { file_path: "~/test.txt" },
        {
          conversationId: "test",
          deviceId: "test",
          requestId: "test",
        }
      );

      // Verify that ~ was expanded (check that access was called with expanded path)
      const accessCalls = mockFs.access.mock.calls;
      expect(accessCalls.length).toBeGreaterThan(0);
      const expandedPath = accessCalls[0][0] as string;
      expect(expandedPath).not.toContain("~");
      expect(expandedPath).toContain(process.env.HOME || process.env.USERPROFILE || "");
    });

    it("should expand $USERPROFILE on Windows", async () => {
      const originalEnv = process.env.USERPROFILE;
      process.env.USERPROFILE = "C:\\Users\\TestUser";

      const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> };
      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("file content");

      await toolHost.executeTool(
        "Read",
        { file_path: "$USERPROFILE/test.txt" },
        {
          conversationId: "test",
          deviceId: "test",
          requestId: "test",
        }
      );

      const accessCalls = mockFs.access.mock.calls;
      if (accessCalls.length > 0) {
        const expandedPath = accessCalls[0][0] as string;
        expect(expandedPath).toContain("TestUser");
      }

      if (originalEnv) {
        process.env.USERPROFILE = originalEnv;
      } else {
        delete process.env.USERPROFILE;
      }
    });

    it("should expand %TEMP% on Windows", async () => {
      const originalEnv = process.env.TEMP;
      process.env.TEMP = "C:\\Temp";

      const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> };
      mockFs.access.mockResolvedValue(undefined);
      mockFs.readFile.mockResolvedValue("file content");

      await toolHost.executeTool(
        "Read",
        { file_path: "%TEMP%/test.txt" },
        {
          conversationId: "test",
          deviceId: "test",
          requestId: "test",
        }
      );

      const accessCalls = mockFs.access.mock.calls;
      if (accessCalls.length > 0) {
        const expandedPath = accessCalls[0][0] as string;
        expect(expandedPath).toContain("Temp");
      }

      if (originalEnv) {
        process.env.TEMP = originalEnv;
      } else {
        delete process.env.TEMP;
      }
    });
  });

  describe("Tool Handlers", () => {
    describe("Read Tool", () => {
      it("should read file with line numbers", async () => {
        const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn>; stat: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> };
        mockFs.access.mockResolvedValue(undefined);
        mockFs.stat.mockResolvedValue({ size: 100 });
        mockFs.readFile.mockResolvedValue("line 1\nline 2\nline 3");

        const result = await toolHost.executeTool(
          "Read",
          { file_path: "/tmp/test.txt", offset: 1, limit: 10 },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(result.result).toBeDefined();
        expect(typeof result.result === "string" && result.result).toContain("File:");
        expect(typeof result.result === "string" && result.result).toContain("line 1");
      });

      it("resolves relative paths from the desktop root", async () => {
        const mockFs = fs as unknown as {
          access: ReturnType<typeof vi.fn>;
          stat: ReturnType<typeof vi.fn>;
          readFile: ReturnType<typeof vi.fn>;
        };
        mockFs.access.mockResolvedValue(undefined);
        mockFs.stat.mockResolvedValue({ size: 32 });
        mockFs.readFile.mockResolvedValue("relative path content");

        const result = await toolHost.executeTool(
          "Read",
          { file_path: "relative/path.txt" },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(result.error).toBeUndefined();
        expect(mockFs.access).toHaveBeenCalledWith(
          path.resolve(process.cwd(), "relative/path.txt"),
        );
      });

      it("should handle file not found", async () => {
        const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn> };
        mockFs.access.mockRejectedValue(new Error("ENOENT"));

        const result = await toolHost.executeTool(
          "Read",
          { file_path: "/nonexistent/file.txt" },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(result.error).toContain("not found");
      });
    });

    describe("Write Tool", () => {
      it("should create a file and parent directories", async () => {
        const mockFs = fs as unknown as {
          readFile: ReturnType<typeof vi.fn>;
          mkdir: ReturnType<typeof vi.fn>;
          writeFile: ReturnType<typeof vi.fn>;
        };
        mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
        mockFs.mkdir.mockResolvedValue(undefined);
        mockFs.writeFile.mockResolvedValue(undefined);

        const result = await toolHost.executeTool(
          "Write",
          { file_path: "/tmp/generated/test.txt", content: "hello world" },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(mockFs.mkdir).toHaveBeenCalledTimes(1);
        expect(mockFs.mkdir.mock.calls[0]?.[0]).toContain("generated");
        expect(mockFs.mkdir.mock.calls[0]?.[1]).toEqual({ recursive: true });
        expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
        expect(mockFs.writeFile.mock.calls[0]?.[0]).toContain("generated");
        expect(mockFs.writeFile.mock.calls[0]?.[0]).toContain("test.txt");
        expect(mockFs.writeFile.mock.calls[0]?.[1]).toBe("hello world");
        expect(mockFs.writeFile.mock.calls[0]?.[2]).toBe("utf-8");
        expect(result.result).toContain("Created");
        expect(result.result).toContain("test.txt");
      });
    });

    describe("Glob Tool", () => {
      it("should find files matching pattern", async () => {
        const mockFs = fs as unknown as { stat: ReturnType<typeof vi.fn>; readdir: ReturnType<typeof vi.fn> };
        mockFs.stat.mockResolvedValue({ isDirectory: () => true });
        
        // Mock readdir to return files
        const mockEntries = [
          { name: "file1.ts", isFile: () => true, isDirectory: () => false },
          { name: "file2.ts", isFile: () => true, isDirectory: () => false },
        ];
        
        mockFs.readdir.mockResolvedValue(mockEntries as never);

        const result = await toolHost.executeTool(
          "Glob",
          { pattern: "*.ts", path: "/tmp" },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(result.result).toBeDefined();
      });

      it("should handle directory not found", async () => {
        const mockFs = fs as unknown as { stat: ReturnType<typeof vi.fn> };
        mockFs.stat.mockRejectedValue(new Error("ENOENT"));

        const result = await toolHost.executeTool(
          "Glob",
          { pattern: "*.ts", path: "/nonexistent" },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(result.error).toContain("not found");
      });
    });

    describe("Grep Tool", () => {
      it("should search for pattern in files", async () => {
        const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn> };
        mockFs.access.mockResolvedValue(undefined);

        // Mock spawn for ripgrep
        const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
        mockSpawn.mockReturnValue({
          stdout: { on: vi.fn((_event, callback) => callback(Buffer.from("file1.ts:10:pattern\n"))),
          },
          stderr: { on: vi.fn() },
          on: vi.fn((event, callback) => {
            if (event === "close") {
              setTimeout(() => callback(0), 10);
            }
          }),
        });

        const result = await toolHost.executeTool(
          "Grep",
          { pattern: "pattern", path: "/tmp", output_mode: "content" },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(result.result).toBeDefined();
        expect(typeof result.result === "string" && result.result).toContain("pattern");
      });
    });

    describe("Schedule Tool", () => {
      it("should delegate a natural-language scheduling request to the schedule agent", async () => {
        let capturedTask: TaskToolRequest | undefined;
        const createTask = vi.fn(async (request: TaskToolRequest) => {
          capturedTask = request;
          return { taskId: "schedule-task-1" };
        });
        const getTask = vi.fn(async () => ({
          id: "schedule-task-1",
          status: "completed" as const,
          description: "Apply local scheduling changes",
          startedAt: Date.now(),
          completedAt: Date.now(),
          result: "Created a weekday reminder and updated the heartbeat.",
        }));
        const cancelTask = vi.fn(async () => ({ canceled: true }));
        const scheduleToolHost = createToolHost({
          stellaHomePath: mockStellaHome,
          taskApi: {
            createTask,
            getTask,
            cancelTask,
          },
        });

        const result = await scheduleToolHost.executeTool(
          "Schedule",
          { prompt: "Every weekday at 9am remind me to review priorities." },
          testContext,
        );

        expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
          conversationId: "test-conv",
          agentType: "schedule",
          description: "Apply local scheduling changes",
          storageMode: "local",
        }));
        expect(capturedTask?.prompt).toContain(
          "Every weekday at 9am remind me to review priorities.",
        );
        expect(getTask).toHaveBeenCalledWith("schedule-task-1");
        expect(cancelTask).not.toHaveBeenCalled();
        expect(result.result).toBe("Created a weekday reminder and updated the heartbeat.");
      });
    });
  });
});
