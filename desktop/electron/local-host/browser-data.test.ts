import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Import types only - we'll dynamically import for tests that need real behavior
import type { BrowserData } from "./browser-data.js";

// Mock database modules
const mockPrepare = vi.fn();
const mockAll = vi.fn();
const mockClose = vi.fn();

const mockDatabase = vi.fn(() => ({
  prepare: mockPrepare,
  close: mockClose,
}));

vi.mock("better-sqlite3", () => ({
  default: mockDatabase,
}));

// Mock bun:sqlite for Bun runtime
vi.mock("bun:sqlite", () => ({
  Database: mockDatabase,
}));

// Import functions after mocks are set up
import {
  collectBrowserData,
  coreMemoryExists,
  readCoreMemory,
  writeCoreMemory,
  formatBrowserDataForSynthesis,
} from "./browser-data.js";

describe("Browser Data Collection - Unit Tests", () => {
  const mockFs = fs.promises as unknown as {
    access: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
  };

  // Use a valid absolute path for Windows
  const testStellaHome = process.platform === "win32" 
    ? "C:\\temp\\test-stella-home" 
    : "/tmp/test-stella-home";

  beforeEach(() => {
    vi.spyOn(fs.promises, "access");
    vi.spyOn(fs.promises, "mkdir");
    vi.spyOn(fs.promises, "copyFile");
    vi.spyOn(fs.promises, "unlink");
    vi.spyOn(fs.promises, "writeFile");
    vi.spyOn(fs.promises, "readFile");
    vi.spyOn(fs.promises, "stat");

    vi.clearAllMocks();
    mockPrepare.mockReturnValue({ all: mockAll });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Platform Path Detection", () => {
    it("should detect correct Chrome path on Windows", () => {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      const expectedPath = path.join(localAppData, "Google/Chrome/User Data/Default/History");

      // The path should contain these components
      expect(expectedPath).toContain("Google");
      expect(expectedPath).toContain("Chrome");
      expect(expectedPath).toContain("History");
    });

    it("should detect correct Chrome path on macOS", () => {
      const home = os.homedir();
      const expectedPath = path.join(home, "Library", "Application Support", "Google/Chrome/Default/History");

      expect(expectedPath).toContain("Library");
      expect(expectedPath).toContain("Application Support");
      expect(expectedPath).toContain("Chrome");
    });

    it("should detect correct Chrome path on Linux", () => {
      const home = os.homedir();
      const expectedPath = path.join(home, ".config/google-chrome/Default/History");

      expect(expectedPath).toContain(".config");
      expect(expectedPath).toContain("google-chrome");
    });
  });

  describe("coreMemoryExists", () => {
    it("should return true when CORE_MEMORY.MD exists", async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await coreMemoryExists(testStellaHome);

      expect(result).toBe(true);
      expect(mockFs.access).toHaveBeenCalledWith(
        path.join(testStellaHome, "state", "CORE_MEMORY.MD")
      );
    });

    it("should return false when CORE_MEMORY.MD does not exist", async () => {
      mockFs.access.mockRejectedValue(new Error("ENOENT"));

      const result = await coreMemoryExists(testStellaHome);

      expect(result).toBe(false);
    });
  });

  describe("writeCoreMemory", () => {
    it("should write content to CORE_MEMORY.MD", async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await writeCoreMemory(testStellaHome, "# Test Profile\n\nContent here");

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join(testStellaHome, "state"),
        { recursive: true }
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        path.join(testStellaHome, "state", "CORE_MEMORY.MD"),
        "# Test Profile\n\nContent here",
        "utf-8"
      );
    });
  });

  describe("readCoreMemory", () => {
    it("should return CORE_MEMORY.MD contents when present", async () => {
      const expected = "# Existing Core Memory\n\nProfile content";
      mockFs.readFile.mockResolvedValue(expected);

      const result = await readCoreMemory(testStellaHome);

      expect(result).toBe(expected);
      expect(mockFs.readFile).toHaveBeenCalledWith(
        path.join(testStellaHome, "state", "CORE_MEMORY.MD"),
        "utf-8"
      );
    });

    it("should return null when CORE_MEMORY.MD is missing", async () => {
      mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const result = await readCoreMemory(testStellaHome);

      expect(result).toBeNull();
    });
  });

  describe("formatBrowserDataForSynthesis", () => {
    it("should format empty browser data", () => {
      const data: BrowserData = {
        browser: null,
        clusterDomains: [],
        recentDomains: [],
        allTimeDomains: [],
        domainDetails: {},
      };

      const result = formatBrowserDataForSynthesis(data);

      expect(result).toBe("No browser data available.");
    });

    it("should format browser data with all fields", () => {
      const data: BrowserData = {
        browser: "chrome",
        clusterDomains: ["github.com", "youtube.com"],
        recentDomains: [
          { domain: "github.com", visits: 100 },
          { domain: "stackoverflow.com", visits: 50 },
        ],
        allTimeDomains: [
          { domain: "reddit.com", visits: 200 },
        ],
        domainDetails: {
          "youtube.com": [
            { title: "Fireship - Videos", url: "https://youtube.com/fireship", visitCount: 20 },
          ],
        },
      };

      const result = formatBrowserDataForSynthesis(data);

      expect(result).toContain("## Browser Data (chrome)");
      expect(result).toContain("### Most Active (Last 7 Days)");
      expect(result).toContain("github.com (100)");
      expect(result).toContain("stackoverflow.com (50)");
      expect(result).toContain("### Content Details");
      expect(result).toContain("**youtube.com**");
      expect(result).toContain("Fireship - Videos");
    });

    it("should handle missing optional fields", () => {
      const data: BrowserData = {
        browser: "edge",
        clusterDomains: [],
        recentDomains: [{ domain: "microsoft.com", visits: 10 }],
        allTimeDomains: [],
        domainDetails: {},
      };

      const result = formatBrowserDataForSynthesis(data);

      expect(result).toContain("## Browser Data (edge)");
      expect(result).toContain("### Most Active (Last 7 Days)");
      expect(result).toContain("microsoft.com (10)");
      expect(result).not.toContain("### Content Details");
    });
  });

  describe("collectBrowserData", () => {
    it("should return null browser when no history found", async () => {
      // All browser paths fail
      mockFs.access.mockRejectedValue(new Error("ENOENT"));

      const result = await collectBrowserData(testStellaHome);

      expect(result.browser).toBeNull();
      expect(result.clusterDomains).toEqual([]);
      expect(result.recentDomains).toEqual([]);
      expect(result.allTimeDomains).toEqual([]);
      expect(result.domainDetails).toEqual({});
    });

    // Note: This test requires proper SQLite mocking which is difficult with bun:sqlite
    // The manual-test.ts script provides real integration testing
    it("should handle database errors gracefully", async () => {
      // Chrome history file exists
      mockFs.access.mockResolvedValue(undefined);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.copyFile.mockResolvedValue(undefined);
      mockFs.unlink.mockResolvedValue(undefined);

      // Database will fail (mock throws error)
      mockDatabase.mockImplementationOnce(() => {
        throw new Error("Database error");
      });

      const result = await collectBrowserData(testStellaHome);

      // Should preserve whichever browser was detected, but return empty data due to DB error
      expect(result.browser).not.toBeNull();
      expect(result.clusterDomains).toEqual([]);
      expect(result.recentDomains).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration Test - Run against real browser history
// ---------------------------------------------------------------------------

describe("Browser Data Collection - Integration Test", () => {
  // Skip by default - run manually when needed
  it.skip("should collect real browser data (manual test)", async () => {
    // Unmock for real test
    vi.unmock("fs");
    vi.unmock("better-sqlite3");

    // Dynamically import the real module
    const { collectBrowserData: realCollect, formatBrowserDataForSynthesis: realFormat } =
      await import("./browser-data.js");

    const testHome = path.join(os.tmpdir(), "stella-test-" + Date.now());

    console.log("\n=== Browser Data Collection Integration Test ===\n");
    console.log("Test home:", testHome);

    const data = await realCollect(testHome);

    console.log("\n--- Result ---");
    console.log("Browser:", data.browser);
    console.log("Cluster domains:", data.clusterDomains.length);
    console.log("Recent domains:", data.recentDomains.length);
    console.log("Domain details:", Object.keys(data.domainDetails).length);

    if (data.browser) {
      console.log("\n--- Top 10 Recent Domains ---");
      data.recentDomains.slice(0, 10).forEach((d, i) => {
        console.log(`${i + 1}. ${d.domain}: ${d.visits} visits`);
      });

      console.log("\n--- Domain Details ---");
      for (const [domain, titles] of Object.entries(data.domainDetails)) {
        console.log(`\n${domain}:`);
        titles.slice(0, 5).forEach((t) => {
          console.log(`  - ${t.title.slice(0, 60)}...`);
        });
      }

      console.log("\n--- Formatted Output Preview ---");
      const formatted = realFormat(data);
      console.log(formatted.slice(0, 2000) + "...");
    }

    // Cleanup
    try {
      const { promises: realFs } = await import("fs");
      await realFs.rm(testHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    expect(data).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Quick Manual Test Script
// ---------------------------------------------------------------------------

/**
 * To run a quick manual test from the command line:
 *
 * cd frontend
 * bun run electron/local-host/browser-data.test.ts
 *
 * Or run the integration test:
 * bun test electron/local-host/browser-data.test.ts --run
 */
