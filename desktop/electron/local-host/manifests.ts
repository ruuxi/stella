import { promises as fs } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

type FrontmatterParseResult = {
  metadata: Record<string, unknown>;
  body: string;
};

const FRONTMATTER_DELIM = "---";

const normalizeStringArray = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : String(item)))
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    // Support comma-separated strings for convenience.
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [String(value)];
};

const extractFrontmatter = (content: string): FrontmatterParseResult => {
  if (!content.startsWith(FRONTMATTER_DELIM)) {
    return { metadata: {}, body: content };
  }

  const lines = content.split("\n");
  if (lines.length < 3) {
    return { metadata: {}, body: content };
  }

  // Find the closing delimiter.
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FRONTMATTER_DELIM) {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    return { metadata: {}, body: content };
  }

  const frontmatterText = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");

  try {
    const parsed = parseYaml(frontmatterText);
    if (parsed && typeof parsed === "object") {
      return { metadata: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Fall through to empty metadata on parse errors.
  }

  return { metadata: {}, body };
};

export type ParsedSkill = {
  id: string;
  name: string;
  description: string;
  markdown: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  tags?: string[];
  version: number;
  source: string;
  filePath: string;
};

export type ParsedAgent = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  defaultSkills?: string[];
  model?: string;
  maxTaskDepth?: number;
  version: number;
  source: string;
  filePath: string;
};

const readMarkdownFile = async (filePath: string) => {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

const coerceVersion = (value: unknown) => {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
};

const deriveIdFromPath = (filePath: string) => {
  const dirName = path.basename(path.dirname(filePath));
  const fileStem = path.basename(filePath, path.extname(filePath));
  return dirName || fileStem || "unknown";
};

export const parseSkillMarkdown = async (
  filePath: string,
  source: string,
): Promise<ParsedSkill | null> => {
  const raw = await readMarkdownFile(filePath);
  if (!raw) return null;

  const { metadata, body } = extractFrontmatter(raw);

  const id =
    (typeof metadata.id === "string" && metadata.id.trim()) || deriveIdFromPath(filePath);
  const name =
    (typeof metadata.name === "string" && metadata.name.trim()) || id;
  const description =
    (typeof metadata.description === "string" && metadata.description.trim()) ||
    "Skill instructions.";

  const agentTypes = normalizeStringArray(metadata.agentTypes);
  const toolsAllowlist = normalizeStringArray(metadata.toolsAllowlist);
  const tags = normalizeStringArray(metadata.tags);

  return {
    id,
    name,
    description,
    markdown: body.trim() ? body : raw,
    agentTypes,
    toolsAllowlist: toolsAllowlist.length > 0 ? toolsAllowlist : undefined,
    tags: tags.length > 0 ? tags : undefined,
    version: coerceVersion(metadata.version),
    source,
    filePath,
  };
};

export const parseAgentMarkdown = async (
  filePath: string,
  source: string,
): Promise<ParsedAgent | null> => {
  const raw = await readMarkdownFile(filePath);
  if (!raw) return null;

  const { metadata, body } = extractFrontmatter(raw);

  const id =
    (typeof metadata.id === "string" && metadata.id.trim()) || deriveIdFromPath(filePath);
  const name =
    (typeof metadata.name === "string" && metadata.name.trim()) || id;
  const description =
    (typeof metadata.description === "string" && metadata.description.trim()) ||
    "Agent instructions.";

  const systemPrompt = body.trim() ? body : raw;
  const agentTypes = normalizeStringArray(metadata.agentTypes);
  const toolsAllowlist = normalizeStringArray(metadata.toolsAllowlist);
  const defaultSkills = normalizeStringArray(metadata.defaultSkills);

  const maxTaskDepthValue = Number(metadata.maxTaskDepth);
  const maxTaskDepth = Number.isFinite(maxTaskDepthValue)
    ? Math.max(1, Math.floor(maxTaskDepthValue))
    : undefined;

  return {
    id,
    name,
    description,
    systemPrompt,
    agentTypes,
    toolsAllowlist: toolsAllowlist.length > 0 ? toolsAllowlist : undefined,
    defaultSkills: defaultSkills.length > 0 ? defaultSkills : undefined,
    model: typeof metadata.model === "string" ? metadata.model : undefined,
    maxTaskDepth,
    version: coerceVersion(metadata.version),
    source,
    filePath,
  };
};

export const listMarkdownFiles = async (baseDir: string, expectedName: string) => {
  const results: string[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(baseDir, entry.name, expectedName);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        results.push(candidate);
      }
    } catch {
      // Skip missing files.
    }
  }

  return results;
};
