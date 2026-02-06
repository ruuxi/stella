import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// Import types
import type { ShellAnalysis, DevProject, DiscoveredApp, AllUserSignals } from "./types.js";
import type { BrowserData } from "./browser-data.js";

// Mock fs
vi.mock("fs", () => ({
  default: {
    promises: {
      access: vi.fn(),
      mkdir: vi.fn(),
      copyFile: vi.fn(),
      unlink: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      readdir: vi.fn(),
      stat: vi.fn(),
    },
  },
  promises: {
    access: vi.fn(),
    mkdir: vi.fn(),
    copyFile: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

// Mock child_process
vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Shell History Tests
// ---------------------------------------------------------------------------

describe("Shell History Analysis", () => {
  const mockFs = vi.mocked(fs.promises);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("analyzeShellHistory", () => {
    it("should extract command frequency from bash history", async () => {
      // Dynamically import after mocks are set up
      const { analyzeShellHistory } = await import("./shell-history.js");

      // Mock bash history content
      (mockFs.readFile as any).mockResolvedValue(
        "git status\nnpm install\ngit status\ngit commit\nnpm install\nnpm install\ncd /projects/test"
      );

      const result = await analyzeShellHistory();

      expect(result.topCommands).toBeDefined();
      expect(result.projectPaths).toBeDefined();
      expect(result.toolsUsed).toBeDefined();
    });

    it("should handle missing history files gracefully", async () => {
      const { analyzeShellHistory } = await import("./shell-history.js");

      (mockFs.readFile as any).mockRejectedValue(new Error("ENOENT"));

      const result = await analyzeShellHistory();

      expect(result.topCommands).toEqual([]);
      expect(result.projectPaths).toEqual([]);
      expect(result.toolsUsed).toEqual([]);
    });
  });

  describe("formatShellAnalysisForSynthesis", () => {
    it("should format shell analysis correctly", async () => {
      const { formatShellAnalysisForSynthesis } = await import("./shell-history.js");

      const data: ShellAnalysis = {
        topCommands: [
          { command: "git", count: 100 },
          { command: "npm", count: 50 },
          { command: "docker", count: 25 },
        ],
        projectPaths: ["/Users/test/projects/app1", "/Users/test/projects/app2"],
        toolsUsed: ["git", "npm", "docker"],
      };

      const result = formatShellAnalysisForSynthesis(data);

      expect(result).toContain("## Shell History");
      expect(result).toContain("### Dev Tools Used");
      expect(result).toContain("git, npm, docker");
    });

    it("should handle empty data", async () => {
      const { formatShellAnalysisForSynthesis } = await import("./shell-history.js");

      const data: ShellAnalysis = {
        topCommands: [],
        projectPaths: [],
        toolsUsed: [],
      };

      const result = formatShellAnalysisForSynthesis(data);

      expect(result).toContain("## Shell History");
    });
  });
});

// ---------------------------------------------------------------------------
// Dev Projects Tests
// ---------------------------------------------------------------------------

describe("Dev Projects Discovery", () => {
  const mockFs = vi.mocked(fs.promises);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("formatDevProjectsForSynthesis", () => {
    it("should format dev projects correctly", async () => {
      const { formatDevProjectsForSynthesis } = await import("./dev-projects.js");

      const projects: DevProject[] = [
        { name: "my-app", path: "/Users/test/projects/my-app", lastActivity: Date.now() - 1000 },
        { name: "lib", path: "/Users/test/projects/lib", lastActivity: Date.now() - 86400000 },
      ];

      const result = formatDevProjectsForSynthesis(projects);

      expect(result).toContain("## Active Projects");
      expect(result).toContain("my-app");
      expect(result).toContain("today");
      expect(result).toContain("lib");
      expect(result).toContain("yesterday");
    });

    it("should return empty string for no projects", async () => {
      const { formatDevProjectsForSynthesis } = await import("./dev-projects.js");

      const result = formatDevProjectsForSynthesis([]);

      expect(result).toBe("");
    });
  });

  describe("collectDevProjects", () => {
    it("should handle missing project directories", async () => {
      const { collectDevProjects } = await import("./dev-projects.js");

      // All directories don't exist
      (mockFs.stat as any).mockRejectedValue(new Error("ENOENT"));

      const result = await collectDevProjects();

      expect(result).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// App Discovery Tests
// ---------------------------------------------------------------------------

describe("App Discovery", () => {
  describe("formatAppDiscoveryForSynthesis", () => {
    it("should format app discovery correctly", async () => {
      const { formatAppDiscoveryForSynthesis } = await import("./app-discovery.js");

      const result = formatAppDiscoveryForSynthesis({
        apps: [
          { name: "Cursor", executablePath: "/Applications/Cursor.app", source: "running" },
          { name: "Slack", executablePath: "/Applications/Slack.app", source: "recent", lastUsed: Date.now() - 3600000 },
        ],
      });

      expect(result).toContain("## Apps");
      expect(result).toContain("### Currently Running");
      expect(result).toContain("Cursor");
      expect(result).toContain("### Recently Used");
      expect(result).toContain("Slack");
    });

    it("should return empty string for no apps", async () => {
      const { formatAppDiscoveryForSynthesis } = await import("./app-discovery.js");

      const result = formatAppDiscoveryForSynthesis({ apps: [] });

      expect(result).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// Collect All Tests
// ---------------------------------------------------------------------------

describe("Collect All Signals", () => {
  describe("formatAllSignalsForSynthesis", () => {
    it("should combine all formatters", async () => {
      const { formatAllSignalsForSynthesis } = await import("./collect-all.js");

      const data: AllUserSignals = {
        browser: {
          browser: "chrome",
          clusterDomains: [],
          recentDomains: [{ domain: "github.com", visits: 100 }],
          allTimeDomains: [],
          domainDetails: {},
        },
        devProjects: [
          { name: "Stella", path: "/projects/Stella", lastActivity: Date.now() },
        ],
        shell: {
          topCommands: [{ command: "git", count: 50 }],
          projectPaths: [],
          toolsUsed: ["git"],
        },
        apps: [
          { name: "Cursor", executablePath: "/Applications/Cursor.app", source: "running" },
        ],
      };

      const result = await formatAllSignalsForSynthesis(data, "/tmp/stella-test");

      expect(result).toContain("## Browser Data");
      expect(result).toContain("## Active Projects");
      expect(result).toContain("## Shell History");
      expect(result).toContain("## Apps");
    });
  });
});

// ---------------------------------------------------------------------------
// Type Tests
// ---------------------------------------------------------------------------

describe("Types", () => {
  it("should have correct DevProject structure", () => {
    const project: DevProject = {
      name: "test",
      path: "/test",
      lastActivity: Date.now(),
    };

    expect(project.name).toBeDefined();
    expect(project.path).toBeDefined();
    expect(project.lastActivity).toBeDefined();
  });

  it("should have correct ShellAnalysis structure", () => {
    const analysis: ShellAnalysis = {
      topCommands: [],
      projectPaths: [],
      toolsUsed: [],
    };

    expect(analysis.topCommands).toBeDefined();
    expect(analysis.projectPaths).toBeDefined();
    expect(analysis.toolsUsed).toBeDefined();
  });

  it("should have correct DiscoveredApp structure", () => {
    const app: DiscoveredApp = {
      name: "Test",
      executablePath: "/test",
      source: "running",
    };

    expect(app.name).toBeDefined();
    expect(app.executablePath).toBeDefined();
    expect(app.source).toBe("running");
  });
});
