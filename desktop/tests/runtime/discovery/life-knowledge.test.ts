import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoveryKnowledgeExists,
  writeDiscoveryKnowledge,
} from "../../../../runtime/discovery/life-knowledge.js";
import type { DiscoveryKnowledgeSeedPayload } from "../../../src/shared/contracts/discovery.js";

const tempDirs: string[] = [];

const createTempHome = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-life-knowledge-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "state", "knowledge"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "state", "registry.md"),
    [
      "# Life Registry",
      "",
      "## Entry Points",
      "",
      "- [Knowledge Index](knowledge/index.md)",
      "",
      "## Fast Paths",
      "",
      "- Browser automation: [stella-browser](abilities/stella-browser.md)",
      "",
      "## Reference Docs",
      "",
      "- [stella-browser command reference](abilities/references/commands.md)",
      "",
      "## Notes",
      "",
      "- Prefer a direct read when you already know the likely document.",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "state", "knowledge", "index.md"),
    [
      "# Knowledge Index",
      "",
      "## Entries",
      "",
      "- [computer-use](computer-use/index.md): browser and desktop-app operating guidance.",
      "",
      "## Related Abilities",
      "",
      "- [stella-browser](../abilities/stella-browser.md)",
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
  it("writes LLM-summarized knowledge pages and raw signal dumps", async () => {
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

    // Knowledge pages contain LLM-summarized content
    const skillFile = await fs.readFile(
      path.join(stellaHome, "state", "knowledge", "user-profile", "index.md"),
      "utf-8",
    );
    const browsingKnowledge = await fs.readFile(
      path.join(stellaHome, "state", "knowledge", "user-profile", "browsing-bookmarks.md"),
      "utf-8",
    );
    const devKnowledge = await fs.readFile(
      path.join(stellaHome, "state", "knowledge", "user-profile", "dev-environment.md"),
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

    // index.md links to both knowledge pages and raw
    expect(skillFile).toContain("## Knowledge Pages");
    expect(skillFile).toContain("[Browsing & Bookmarks](browsing-bookmarks.md)");
    expect(skillFile).toContain("[Development Environment](dev-environment.md)");
    expect(skillFile).toContain("## Raw Discovery Data");
    expect(skillFile).toContain("../../raw/discovery/browsing-bookmarks.md");

    // Knowledge pages have LLM-summarized content, not raw domain lists
    expect(browsingKnowledge).toContain("heavy user of AI coding tools");
    expect(browsingKnowledge).not.toContain("cursor.com (12)");
    expect(browsingKnowledge).toContain("Raw: [Browsing & Bookmarks]");

    expect(devKnowledge).toContain("Two active projects");
    expect(devKnowledge).not.toContain("847 files");

    // Raw files contain the unprocessed signal data
    expect(rawBrowsing).toContain("Browsing & Bookmarks (Raw)");
    expect(rawBrowsing).toContain("cursor.com (12)");
    expect(rawBrowsing).toContain("github.com (45)");

    expect(rawDev).toContain("Development Environment (Raw)");
    expect(rawDev).toContain("/Users/rahulnanda/projects/stella");
    expect(rawDev).toContain("847 files");

    // Index and registry updated
    const knowledgeIndex = await fs.readFile(
      path.join(stellaHome, "state", "knowledge", "index.md"),
      "utf-8",
    );
    expect(knowledgeIndex).toContain("[user-profile](user-profile/index.md)");
  });

  it("skips knowledge pages when categoryAnalyses is absent", async () => {
    const stellaHome = await createTempHome();
    const payload: DiscoveryKnowledgeSeedPayload = {
      coreMemory: "[who]\n- Test user.\n",
      formattedSections: {
        browsing_bookmarks: "cursor.com (5)",
      },
    };

    await writeDiscoveryKnowledge(stellaHome, payload);

    // index.md exists
    const skillFile = await fs.readFile(
      path.join(stellaHome, "state", "knowledge", "user-profile", "index.md"),
      "utf-8",
    );
    expect(skillFile).toContain("No knowledge pages are populated yet.");

    // Raw still written
    const rawBrowsing = await fs.readFile(
      path.join(stellaHome, "state", "raw", "discovery", "browsing-bookmarks.md"),
      "utf-8",
    );
    expect(rawBrowsing).toContain("cursor.com (5)");

    // No knowledge page for browsing since no analysis was provided
    await expect(
      fs.access(
        path.join(stellaHome, "state", "knowledge", "user-profile", "browsing-bookmarks.md"),
      ),
    ).rejects.toThrow();
  });

  it("does not duplicate registry or knowledge index entries on repeated writes", async () => {
    const stellaHome = await createTempHome();
    const payload: DiscoveryKnowledgeSeedPayload = {
      coreMemory: "[who]\n- Test user.\n",
      formattedSections: {},
    };

    await writeDiscoveryKnowledge(stellaHome, payload);
    await writeDiscoveryKnowledge(stellaHome, payload);

    const knowledgeIndex = await fs.readFile(
      path.join(stellaHome, "state", "knowledge", "index.md"),
      "utf-8",
    );
    const registry = await fs.readFile(
      path.join(stellaHome, "state", "registry.md"),
      "utf-8",
    );

    expect(
      knowledgeIndex.match(/\[user-profile\]\(user-profile\/index\.md\)/g)?.length,
    ).toBe(1);
    expect(
      registry.match(
        /User profile and context: \[user-profile\]\(knowledge\/user-profile\/index\.md\)/g,
      )?.length,
    ).toBe(1);
  });
});
