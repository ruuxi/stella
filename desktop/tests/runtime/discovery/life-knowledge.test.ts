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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-life-knowledge-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "state", "skills"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "state", "registry.md"),
    [
      "# Life Registry",
      "",
      "## Entry Points",
      "",
      "- [Skills Index](skills/index.md)",
      "",
      "## Fast Paths",
      "",
      "- Browser automation: [stella-browser](skills/stella-browser/SKILL.md)",
      "- User profile and context: [user-profile](skills/user-profile/SKILL.md)",
      "",
      "## Reference Docs",
      "",
      "- [stella-browser command reference](skills/stella-browser/references/commands.md)",
      "",
      "## Notes",
      "",
      "- Prefer a direct read when you already know the likely document.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "state", "skills", "index.md"),
    [
      "# Skills Index",
      "",
      "## Entries",
      "",
      "- [stella-computer](stella-computer/SKILL.md): browser and desktop-app operating guidance.",
      "- [user-profile](user-profile/SKILL.md): structured onboarding memory for the user, including projects, apps, interests, and environment.",
      "",
      "## Related Abilities",
      "",
      "- [stella-browser](stella-browser/SKILL.md)",
      "",
      "## Backlinks",
      "",
      "- [Life Registry](../registry.md)",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("life knowledge discovery writer", () => {
  it("writes LLM-summarized summary pages and raw signal dumps", async () => {
    const stellaHome = await createTempHome();
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

    expect(await discoveryKnowledgeExists(stellaHome)).toBe(false);

    await writeDiscoveryKnowledge(stellaHome, payload);

    expect(await discoveryKnowledgeExists(stellaHome)).toBe(true);

    // Skill file (user-profile/SKILL.md) and per-category summary pages
    const skillFile = await fs.readFile(
      path.join(stellaHome, "state", "skills", "user-profile", "SKILL.md"),
      "utf-8",
    );
    const browsingSummary = await fs.readFile(
      path.join(stellaHome, "state", "skills", "user-profile", "browsing-bookmarks.md"),
      "utf-8",
    );
    const devSummary = await fs.readFile(
      path.join(stellaHome, "state", "skills", "user-profile", "dev-environment.md"),
      "utf-8",
    );

    // Raw signal dumps
    const rawBrowsing = await fs.readFile(
      path.join(stellaHome, "state", "raw", "discovery", "browsing-bookmarks.md"),
      "utf-8",
    );
    const rawDev = await fs.readFile(
      path.join(stellaHome, "state", "raw", "discovery", "dev-environment.md"),
      "utf-8",
    );

    // SKILL.md links to both summary pages and raw
    expect(skillFile).toContain("## Summary Pages");
    expect(skillFile).toContain("[Browsing & Bookmarks](browsing-bookmarks.md)");
    expect(skillFile).toContain("[Development Environment](dev-environment.md)");
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

    // Index and registry already include the static user-profile entry.
    const skillsIndex = await fs.readFile(
      path.join(stellaHome, "state", "skills", "index.md"),
      "utf-8",
    );
    expect(skillsIndex).toContain("[user-profile](user-profile/SKILL.md)");
  });

  it("skips summary pages when categoryAnalyses is absent", async () => {
    const stellaHome = await createTempHome();
    const payload: DiscoveryKnowledgeSeedPayload = {
      coreMemory: "[who]\n- Test user.\n",
      formattedSections: {
        browsing_bookmarks: "cursor.com (5)",
      },
    };

    await writeDiscoveryKnowledge(stellaHome, payload);

    // SKILL.md exists
    const skillFile = await fs.readFile(
      path.join(stellaHome, "state", "skills", "user-profile", "SKILL.md"),
      "utf-8",
    );
    expect(skillFile).toContain("No summary pages are populated yet.");

    // Raw still written
    const rawBrowsing = await fs.readFile(
      path.join(stellaHome, "state", "raw", "discovery", "browsing-bookmarks.md"),
      "utf-8",
    );
    expect(rawBrowsing).toContain("cursor.com (5)");

    // No summary page for browsing since no analysis was provided
    await expect(
      fs.access(
        path.join(stellaHome, "state", "skills", "user-profile", "browsing-bookmarks.md"),
      ),
    ).rejects.toThrow();
  });

  it("does not modify static registry or skills index entries on repeated writes", async () => {
    const stellaHome = await createTempHome();
    const payload: DiscoveryKnowledgeSeedPayload = {
      coreMemory: "[who]\n- Test user.\n",
      formattedSections: {},
    };
    const initialSkillsIndex = await fs.readFile(
      path.join(stellaHome, "state", "skills", "index.md"),
      "utf-8",
    );
    const initialRegistry = await fs.readFile(
      path.join(stellaHome, "state", "registry.md"),
      "utf-8",
    );

    await writeDiscoveryKnowledge(stellaHome, payload);
    await writeDiscoveryKnowledge(stellaHome, payload);

    const skillsIndex = await fs.readFile(
      path.join(stellaHome, "state", "skills", "index.md"),
      "utf-8",
    );
    const registry = await fs.readFile(
      path.join(stellaHome, "state", "registry.md"),
      "utf-8",
    );

    expect(skillsIndex).toBe(initialSkillsIndex);
    expect(registry).toBe(initialRegistry);
    expect(
      skillsIndex.match(/\[user-profile\]\(user-profile\/SKILL\.md\)/g)?.length,
    ).toBe(1);
    expect(
      registry.match(
        /User profile and context: \[user-profile\]\(skills\/user-profile\/SKILL\.md\)/g,
      )?.length,
    ).toBe(1);
  });
});
