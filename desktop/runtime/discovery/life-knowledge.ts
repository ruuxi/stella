import fs from "node:fs/promises";
import path from "node:path";
import type {
  DiscoveryCategory,
  DiscoveryKnowledgeSeedPayload,
} from "../../src/shared/contracts/discovery.js";

const USER_PROFILE_SLUG = "user-profile";
const USER_PROFILE_TITLE = "User Profile";
const USER_PROFILE_DESCRIPTION =
  "Structured onboarding memory for the user, with backlinks to raw discovery data.";

const KNOWLEDGE_INDEX_LINE = `- [${USER_PROFILE_SLUG}](${USER_PROFILE_SLUG}/index.md): structured onboarding memory for the user, including projects, apps, interests, and environment.`;
const REGISTRY_FAST_PATH_LINE =
  `- User profile and context: [${USER_PROFILE_SLUG}](knowledge/${USER_PROFILE_SLUG}/index.md)`;

const RAW_DISCOVERY_DIR = "discovery";

type RawSignalPage = {
  key: DiscoveryCategory;
  title: string;
  fileName: string;
};

const rawSignalPages: RawSignalPage[] = [
  { key: "browsing_bookmarks", title: "Browsing & Bookmarks", fileName: "browsing-bookmarks.md" },
  { key: "dev_environment", title: "Development Environment", fileName: "dev-environment.md" },
  { key: "apps_system", title: "Apps & System", fileName: "apps-system.md" },
  { key: "messages_notes", title: "Messages & Notes", fileName: "messages-notes.md" },
];

type KnowledgePageDef = {
  key: DiscoveryCategory;
  fileName: string;
  title: string;
};

const knowledgePages: KnowledgePageDef[] = [
  { key: "browsing_bookmarks", fileName: "browsing-bookmarks.md", title: "Browsing & Bookmarks" },
  { key: "dev_environment", fileName: "dev-environment.md", title: "Development Environment" },
  { key: "apps_system", fileName: "apps-system.md", title: "Apps & System" },
  { key: "messages_notes", fileName: "messages-notes.md", title: "Messages & Notes" },
];

const normalizeContent = (value: string): string => value.trim().replace(/\n{3,}/g, "\n\n");

const topicDir = (stellaHome: string) =>
  path.join(stellaHome, "life", "knowledge", USER_PROFILE_SLUG);

const rawDiscoveryDir = (stellaHome: string) =>
  path.join(stellaHome, "life", "raw", RAW_DISCOVERY_DIR);

const knowledgeIndexPath = (stellaHome: string) =>
  path.join(stellaHome, "life", "knowledge", "index.md");

const registryPath = (stellaHome: string) =>
  path.join(stellaHome, "life", "registry.md");

const rawRelPath = (fileName: string) =>
  `../../raw/${RAW_DISCOVERY_DIR}/${fileName}`;

const buildRawFile = (page: RawSignalPage, content: string): string =>
  [
    `# ${page.title} (Raw)`,
    "",
    "Unprocessed discovery signals collected during onboarding.",
    `See the curated version in the [User Profile](../../knowledge/${USER_PROFILE_SLUG}/index.md).`,
    "",
    normalizeContent(content),
  ].join("\n");

const buildKnowledgePage = (
  page: KnowledgePageDef,
  analysis: string,
  hasRaw: boolean,
): string => {
  const lines = [
    `# ${page.title}`,
    "",
    normalizeContent(analysis),
  ];

  if (hasRaw) {
    const rawPage = rawSignalPages.find((r) => r.key === page.key);
    if (rawPage) {
      lines.push(
        "",
        "## Backlinks",
        "",
        `- [${USER_PROFILE_TITLE}](index.md)`,
        `- Raw: [${rawPage.title}](${rawRelPath(rawPage.fileName)})`,
        "- [Knowledge Index](../index.md)",
      );
    }
  } else {
    lines.push(
      "",
      "## Backlinks",
      "",
      `- [${USER_PROFILE_TITLE}](index.md)`,
      "- [Knowledge Index](../index.md)",
    );
  }

  return lines.join("\n");
};

const bulletIf = (condition: boolean, line: string): string | null =>
  condition ? `- ${line}` : null;

const buildSkillFile = (
  availableKnowledgePages: KnowledgePageDef[],
  availableRawPages: RawSignalPage[],
): string => {
  const pageLinks = availableKnowledgePages.map(
    (page) => `- [${page.title}](${page.fileName})`,
  );

  const rawLinks = availableRawPages.map(
    (page) => `- [${page.title}](${rawRelPath(page.fileName)})`,
  );

  return [
    "---",
    `name: ${USER_PROFILE_TITLE}`,
    `description: ${USER_PROFILE_DESCRIPTION}`,
    "---",
    "",
    `# ${USER_PROFILE_TITLE}`,
    "",
    "Stella's structured onboarding memory for the user.",
    "Use it when grounding work in the user's identity, projects, tools, interests, or environment.",
    "",
    "## How To Use",
    "",
    "- Start with the knowledge pages below — they are LLM-summarized from raw discovery data.",
    "- Drop into raw when you need the full unprocessed source material.",
    "- Prefer updating these pages over expanding `CORE_MEMORY.MD` when new durable context appears.",
    "",
    "## Knowledge Pages",
    "",
    ...(pageLinks.length > 0 ? pageLinks : ["- No knowledge pages are populated yet."]),
    "",
    "## Raw Discovery Data",
    "",
    ...(rawLinks.length > 0
      ? rawLinks
      : ["- No raw discovery data was captured."]),
    "",
    "## Backlinks",
    "",
    "- [Knowledge Index](../index.md)",
    "- [Life Registry](../../registry.md)",
  ].join("\n");
};

const upsertLineBeforeHeading = (
  content: string,
  line: string,
  nextHeading: string,
): string => {
  if (content.includes(line)) {
    return content;
  }

  const marker = `\n${nextHeading}`;
  const index = content.indexOf(marker);
  if (index === -1) {
    return `${content.trimEnd()}\n${line}\n`;
  }

  return `${content.slice(0, index).trimEnd()}\n${line}\n\n${content.slice(index + 1)}`;
};

const ensureKnowledgeIndexEntry = async (stellaHome: string) => {
  const filePath = knowledgeIndexPath(stellaHome);
  const content = await fs.readFile(filePath, "utf-8");
  const updated = upsertLineBeforeHeading(
    content,
    KNOWLEDGE_INDEX_LINE,
    "## Related Abilities",
  );
  if (updated !== content) {
    await fs.writeFile(filePath, updated, "utf-8");
  }
};

const ensureRegistryEntry = async (stellaHome: string) => {
  const filePath = registryPath(stellaHome);
  const content = await fs.readFile(filePath, "utf-8");
  const updated = upsertLineBeforeHeading(
    content,
    REGISTRY_FAST_PATH_LINE,
    "## Reference Docs",
  );
  if (updated !== content) {
    await fs.writeFile(filePath, updated, "utf-8");
  }
};

export const discoveryKnowledgeExists = async (
  stellaHome: string,
): Promise<boolean> => {
  try {
    await fs.access(path.join(topicDir(stellaHome), "index.md"));
    return true;
  } catch {
    return false;
  }
};

export const writeDiscoveryKnowledge = async (
  stellaHome: string,
  payload: DiscoveryKnowledgeSeedPayload,
): Promise<void> => {
  const knowledgeRoot = topicDir(stellaHome);
  const rawRoot = rawDiscoveryDir(stellaHome);
  await Promise.all([
    fs.mkdir(knowledgeRoot, { recursive: true }),
    fs.mkdir(rawRoot, { recursive: true }),
  ]);

  const analyses = payload.categoryAnalyses ?? {};

  const availableRawPages = rawSignalPages.filter(
    (page) => payload.formattedSections[page.key]?.trim().length,
  );
  const availableRawKeys = new Set(availableRawPages.map((p) => p.key));

  const availableKnowledgePages = knowledgePages.filter(
    (page) => analyses[page.key]?.trim().length,
  );

  await Promise.all([
    fs.writeFile(
      path.join(knowledgeRoot, "index.md"),
      buildSkillFile(availableKnowledgePages, availableRawPages),
      "utf-8",
    ),

    // LLM-summarized knowledge pages
    ...availableKnowledgePages.map((page) =>
      fs.writeFile(
        path.join(knowledgeRoot, page.fileName),
        buildKnowledgePage(page, analyses[page.key]!, availableRawKeys.has(page.key)),
        "utf-8",
      ),
    ),

    // Raw signal dumps
    ...availableRawPages.map((page) =>
      fs.writeFile(
        path.join(rawRoot, page.fileName),
        buildRawFile(page, payload.formattedSections[page.key]!),
        "utf-8",
      ),
    ),
  ]);

  await Promise.all([
    ensureKnowledgeIndexEntry(stellaHome),
    ensureRegistryEntry(stellaHome),
  ]);
};
