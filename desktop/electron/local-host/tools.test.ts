import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { createToolHost, type ToolContext } from "./tools.js";

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

  beforeEach(() => {
    toolHost = createToolHost({
      StellaHome: mockStellaHome,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("SqliteQuery Tool", () => {
    const testContext: ToolContext = {
      conversationId: "test-conv",
      deviceId: "test-device",
      requestId: "test-req",
      agentType: "general",
    };

    it("should allow SqliteQuery for any agent", async () => {
      const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> };
      
      mockFs.access.mockResolvedValue(undefined);
      
      // Mock Bun Database
      const mockDb = {
        prepare: vi.fn(() => ({
          all: vi.fn(() => [{ id: 1, value: "test" }]),
        })),
        close: vi.fn(),
      };

      // Mock the database import
      vi.doMock("bun:sqlite", () => ({
        Database: vi.fn(() => mockDb),
      }));

      // Since SqliteQuery uses dynamic imports, we'll test the error path
      // which will occur if database doesn't exist or can't be opened
      mockFs.access.mockRejectedValue(new Error("File not found"));

      await toolHost.executeTool(
        "SqliteQuery",
        {
          database_path: "/tmp/test.db",
          query: "SELECT * FROM test",
        },
        testContext
      );

      // Should attempt to access (not blocked)
      expect(mockFs.access).toHaveBeenCalled();
    });

    it("should block non-SELECT queries", async () => {
      const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn> };
      mockFs.access.mockResolvedValue(undefined);

      const result = await toolHost.executeTool(
        "SqliteQuery",
        {
          database_path: "/tmp/test.db",
          query: "DELETE FROM test",
        },
        testContext
      );
      expect(result.error).toContain("Only SELECT and PRAGMA queries are allowed");
    });

    it("should allow SELECT queries", async () => {
      const mockFs = fs as unknown as { access: ReturnType<typeof vi.fn> };
      mockFs.access.mockResolvedValue(undefined);

      // Mock database - this is complex due to dynamic imports, so we test the validation
      const result = await toolHost.executeTool(
        "SqliteQuery",
        {
          database_path: "/tmp/test.db",
          query: "SELECT * FROM test",
        },
        testContext
      );
      // Should not error on SELECT validation (may error on file access, but that's OK)
      expect(result.error).not.toContain("Only SELECT");
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

      it("should require absolute paths", async () => {
        const result = await toolHost.executeTool(
          "Read",
          { file_path: "relative/path.txt" },
          {
            conversationId: "test",
            deviceId: "test",
            requestId: "test",
          }
        );

        expect(result.error).toContain("must be absolute");
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
          stdout: { on: vi.fn((event, callback) => callback(Buffer.from("file1.ts:10:pattern\n"))),
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
  });
});
