import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoveryKnowledgeExists,
  writeDiscoveryKnowledge,
} from "../../../../runtime/discovery/life-knowledge.js";
import type { DiscoveryKnowledgeSeedPayload } from "../../../../runtime/contracts/discovery.js";

const tempDirs: string[] = [];

const createTempHome = async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "stella-life-knowledge-"),
  );
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("life knowledge discovery writer", () => {
  it("writes LLM-summarized summary pages and raw signal dumps", async () => {
    const stellaDataDir = await createTempHome();
    const payload: DiscoveryKnowledgeSeedPayload = {
      coreMemory: "[who]\n- Rahul builds Stella.\n",
      formattedSections: {
        browsing_bookmarks: [
          "## Browser Data (chrome)",
          "",
          "### Most Active (Last 7 Days)",
          "cursor.com (12)",
          "anthropic.com (8)",
          "github.com (45)",
        ].join("\n"),
        dev_environment: [
          "## Development Projects",
          "",
          "- /Users/rahulnanda/projects/stella (TypeScript, 847 files)",
          "- /Users/rahulnanda/projects/OfficeCli (C#, 120 files)",
        ].join("\n"),
      },
      categoryAnalyses: {
        browsing_bookmarks:
          "Rahul is a heavy user of AI coding tools and developer platforms. " +
          "Cursor IDE and Anthropic documentation are visited daily. " +
          "GitHub activity centers on the stella repository with frequent PR reviews.",
        dev_environment:
          "Two active projects: Stella (primary, TypeScript) is a large Electron app " +
          "with an AI runtime kernel. OfficeCli is a smaller C# CLI tool for document manipulation. " +
          "Shell history shows heavy use of git, npm, and vitest.",
      },
    };

    expect(await discoveryKnowledgeExists(stellaDataDir)).toBe(false);

    await writeDiscoveryKnowledge(stellaDataDir, payload);

    expect(await discoveryKnowledgeExists(stellaDataDir)).toBe(true);

    // Skill file (user-profile/SKILL.md) and per-category summary pages
    const skillFile = await fs.readFile(
      path.join(stellaDataDir, "skills", "user-profile", "SKILL.md"),
      "utf-8",
    );
    const browsingSummary = await fs.readFile(
      path.join(stellaDataDir, "skills", "user-profile", "browsing-bookmarks.md"),
      "utf-8",
    );
    const devSummary = await fs.readFile(
      path.join(stellaDataDir, "skills", "user-profile", "dev-environment.md"),
      "utf-8",
    );

    // Raw signal dumps
    const rawBrowsing = await fs.readFile(
      path.join(stellaDataDir, "raw", "discovery", "browsing-bookmarks.md"),
      "utf-8",
    );
    const rawDev = await fs.readFile(
      path.join(stellaDataDir, "raw", "discovery", "dev-environment.md"),
      "utf-8",
    );

    // SKILL.md links to both summary pages and raw
    expect(skillFile).toContain("## Summary Pages");
    expect(skillFile).toContain(
      "[Browsing & Bookmarks](browsing-bookmarks.md)",
    );
    expect(skillFile).toContain(
      "[Development Environment](dev-environment.md)",
    );
    expect(skillFile).toContain("## Raw Discovery Data");
    expect(skillFile).toContain("../../raw/discovery/browsing-bookmarks.md");

    // Summary pages have LLM-summarized content, not raw domain lists
    expect(browsingSummary).toContain("heavy user of AI coding tools");
    expect(browsingSummary).not.toContain("cursor.com (12)");
    expect(browsingSummary).toContain("Raw: [Browsing & Bookmarks]");

    expect(devSummary).toContain("Two active projects");
    expect(devSummary).not.toContain("847 files");

    // Raw files contain the unprocessed signal data
    expect(rawBrowsing).toContain("Browsing & Bookmarks (Raw)");
    expect(rawBrowsing).toContain("cursor.com (12)");
    expect(rawBrowsing).toContain("github.com (45)");

    expect(rawDev).toContain("Development Environment (Raw)");
    expect(rawDev).toContain("/Users/rahulnanda/projects/stella");
    expect(rawDev).toContain("847 files");
  });

  it("skips summary pages when categoryAnalyses is absent", async () => {
    const stellaDataDir = await createTempHome();
    const payload: DiscoveryKnowledgeSeedPayload = {
      coreMemory: "[who]\n- Test user.\n",
      formattedSections: {
        browsing_bookmarks: "cursor.com (5)",
      },
    };

    await writeDiscoveryKnowledge(stellaDataDir, payload);

    // SKILL.md exists
    const skillFile = await fs.readFile(
      path.join(stellaDataDir, "skills", "user-profile", "SKILL.md"),
      "utf-8",
    );
    expect(skillFile).toContain("No summary pages are populated yet.");

    // Raw still written
    const rawBrowsing = await fs.readFile(
      path.join(stellaDataDir, "raw", "discovery", "browsing-bookmarks.md"),
      "utf-8",
    );
    expect(rawBrowsing).toContain("cursor.com (5)");

    // No summary page for browsing since no analysis was provided
    await expect(
      fs.access(
        path.join(
          stellaDataDir,
          "skills",
          "user-profile",
          "browsing-bookmarks.md",
        ),
      ),
    ).rejects.toThrow();
  });

});
