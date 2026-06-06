import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { statSignature } from "./fs-signature.js";

export const INLINE_SKILL_CATALOG_THRESHOLD = 50;

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  path: string;
  hasProgram: boolean;
};

export type SkillCatalogPromptState = {
  mode: "inline" | "placeholder";
  totalSkills: number;
  entries: SkillCatalogEntry[];
  block: string;
};

export type SkillCatalogRenderOptions = {
  omitSkillIds?: readonly string[];
};

const SKILLS_DIR_NAME = "skills";
const SKILL_FILENAME = "SKILL.md";
const PROGRAM_FILENAME = path.join("scripts", "program.ts");

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : null;
};

const parseLooseHeader = (
  content: string,
): {
  name?: string;
  description?: string;
} => {
  const out: { name?: string; description?: string } = {};
  const lines = content.split(/\r?\n/u).slice(0, 16);
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:#+\s*)?(name|description)\s*:\s*(.+?)\s*$/iu,
    );
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim();
    if (!key || !value) continue;
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
};

const listSkillDirectoryIds = async (stellaRoot: string): Promise<string[]> => {
  const skillsRoot = path.join(stellaRoot, SKILLS_DIR_NAME);
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
};

const filterSkillDirectoryIds = (
  skillIds: readonly string[],
  options: SkillCatalogRenderOptions = {},
): string[] => {
  const omitted = new Set(options.omitSkillIds ?? []);
  if (omitted.size === 0) return [...skillIds];
  return skillIds.filter((skillId) => !omitted.has(skillId));
};

// Per-SKILL.md cache so an unchanged skill is never re-read or re-parsed on a
// later turn. The directory listing still runs each turn (cheap, and needed to
// detect added/removed skills); only the file read + frontmatter parse is gated
// behind an mtime+size signature that also folds in `scripts/program.ts`
// presence (a program add/remove changes the rendered entry).
const skillEntryCache = new Map<
  string,
  { sig: string; entry: SkillCatalogEntry }
>();

const readSkillCatalogEntry = async (
  skillsRoot: string,
  skillId: string,
): Promise<SkillCatalogEntry> => {
  const skillDir = path.join(skillsRoot, skillId);
  const skillPath = path.join(skillDir, SKILL_FILENAME);
  const programPath = path.join(skillDir, PROGRAM_FILENAME);

  const [skillSig, hasProgram] = await Promise.all([
    statSignature(skillPath),
    fs
      .stat(programPath)
      .then(() => true)
      .catch(() => false),
  ]);

  const sig = `${skillSig ?? "missing"}:${hasProgram}`;
  const cached = skillEntryCache.get(skillPath);
  if (cached && cached.sig === sig) {
    return cached.entry;
  }

  const docs =
    skillSig === null
      ? ""
      : await fs.readFile(skillPath, "utf-8").catch(() => "");

  const parsed = docs ? extractFrontmatter(docs) : { metadata: {}, body: "" };
  const looseHeader = docs ? parseLooseHeader(docs) : {};
  const name =
    asNonEmptyString(parsed.metadata.name) ??
    asNonEmptyString(looseHeader.name) ??
    skillId;
  const description =
    asNonEmptyString(parsed.metadata.description) ??
    asNonEmptyString(looseHeader.description) ??
    skillId;

  const entry: SkillCatalogEntry = {
    id: skillId,
    name,
    description,
    path: path.posix.join("~/.stella", SKILLS_DIR_NAME, skillId, SKILL_FILENAME),
    hasProgram,
  };
  skillEntryCache.set(skillPath, { sig, entry });
  return entry;
};

export const listSkillCatalogEntries = async (
  stellaRoot: string,
  options: SkillCatalogRenderOptions = {},
): Promise<SkillCatalogEntry[]> => {
  const skillsRoot = path.join(stellaRoot, SKILLS_DIR_NAME);
  const skillIds = filterSkillDirectoryIds(
    await listSkillDirectoryIds(stellaRoot),
    options,
  );
  return await Promise.all(
    skillIds.map((skillId) => readSkillCatalogEntry(skillsRoot, skillId)),
  );
};

export const shouldUseAutomaticSkillExplore = async (
  stellaRoot: string,
): Promise<boolean> => {
  const skillIds = await listSkillDirectoryIds(stellaRoot);
  return skillIds.length > INLINE_SKILL_CATALOG_THRESHOLD;
};

const renderInlineSkillCatalogBlock = (
  entries: readonly SkillCatalogEntry[],
): string => {
  const lines = [
    "<skills>",
    "## Skills",
    "## Available skills",
  ];

  if (entries.length === 0) {
    lines.push("- No saved skills yet.");
  } else {
    for (const entry of entries) {
      const suffix = entry.hasProgram ? " Includes optional `scripts/program.ts`." : "";
      lines.push(
        `- \`${entry.id}\` — ${entry.description} (path: ${entry.path})${suffix}`,
      );
    }
  }

  lines.push("## How to use skills");
  lines.push(
    "- If a task matches a skill description, open its `SKILL.md` first.",
  );
  lines.push(
    '- If a skill tells you to run `scripts/program.ts`, do it as a plain shell command with `exec_command`, e.g. `exec_command({ cmd: "bun ~/.stella/skills/<name>/scripts/program.ts" })`.',
  );
  lines.push(
    "- When you finish a non-trivial reusable workflow, consider saving it as a new skill under `~/.stella/skills/`.",
  );
  lines.push("</skills>");

  return lines.join("\n");
};

const renderPlaceholderSkillCatalogBlock = (totalSkills: number): string =>
  [
    "<skills>",
    "## Skills",
    `- ${totalSkills} saved skills are available under \`~/.stella/skills/\`.`,
    `- The full skill catalog is omitted because it is over the inline limit (${INLINE_SKILL_CATALOG_THRESHOLD}).`,
    "- Automatic Explore fallback may surface the relevant skill paths before a General task starts.",
    "## How to use skills",
    "- If automatic findings point to a skill, open its `SKILL.md` first.",
    '- If you already know a likely skill path, inspect it directly with `exec_command`, for example `exec_command({ cmd: "sed -n \'1,220p\' ~/.stella/skills/<name>/SKILL.md" })`.',
    '- If a skill tells you to run `scripts/program.ts`, do it as a plain shell command with `exec_command`, e.g. `exec_command({ cmd: "bun ~/.stella/skills/<name>/scripts/program.ts" })`.',
    "</skills>",
  ].join("\n");

export const buildSkillCatalogPromptState = async (
  stellaRoot: string,
  options: SkillCatalogRenderOptions = {},
): Promise<SkillCatalogPromptState> => {
  const skillIds = filterSkillDirectoryIds(
    await listSkillDirectoryIds(stellaRoot),
    options,
  );
  if (skillIds.length > INLINE_SKILL_CATALOG_THRESHOLD) {
    return {
      mode: "placeholder",
      totalSkills: skillIds.length,
      entries: [],
      block: renderPlaceholderSkillCatalogBlock(skillIds.length),
    };
  }

  const entries = await listSkillCatalogEntries(stellaRoot, options);
  return {
    mode: "inline",
    totalSkills: entries.length,
    entries,
    block: renderInlineSkillCatalogBlock(entries),
  };
};

export const renderSkillCatalogBlock = async (
  stellaRoot: string,
  options: SkillCatalogRenderOptions = {},
): Promise<string> => {
  const state = await buildSkillCatalogPromptState(stellaRoot, options);
  return state.block;
};

/**
 * Render every skill as an inline catalog, ignoring the inline/placeholder
 * threshold. Used by the Explore agent, whose entire job is skill selection —
 * it should always see the full catalog rather than the placeholder, even
 * (especially) when the count is above {@link INLINE_SKILL_CATALOG_THRESHOLD}.
 * Omits the general-agent "how to use" footer; Explore has its own usage rules.
 */
export const renderFullSkillCatalogBlock = async (
  stellaRoot: string,
  options: SkillCatalogRenderOptions = {},
): Promise<string> => {
  const entries = await listSkillCatalogEntries(stellaRoot, options);
  const lines = ["<skills>", "## Available skills"];
  if (entries.length === 0) {
    lines.push("- No saved skills yet.");
  } else {
    for (const entry of entries) {
      const suffix = entry.hasProgram
        ? " Includes optional `scripts/program.ts`."
        : "";
      lines.push(
        `- \`${entry.id}\` — ${entry.description} (path: ${entry.path})${suffix}`,
      );
    }
  }
  lines.push("</skills>");
  return lines.join("\n");
};
