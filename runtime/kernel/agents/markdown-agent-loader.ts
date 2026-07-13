import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFrontmatter } from "../frontmatter.js";
import type { ParsedAgent } from "./types.js";

const parseStringList = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
};

const normalizeAgent = (
  filePath: string,
  raw: string,
  allowMetadataOnly = false,
): ParsedAgent | null => {
  const { metadata, body } = extractFrontmatter(raw);
  const id = path.basename(filePath, path.extname(filePath)).trim();
  const name =
    typeof metadata.name === "string" && metadata.name.trim().length > 0
      ? metadata.name.trim()
      : id;
  const description =
    typeof metadata.description === "string" &&
    metadata.description.trim().length > 0
      ? metadata.description.trim()
      : "";
  const systemPrompt = body.trim();
  if (!id || !description || (!systemPrompt && !allowMetadataOnly)) {
    return null;
  }

  const agentTypes = parseStringList(metadata.agentTypes) ?? [id];
  const toolsAllowlist = parseStringList(metadata.tools);
  const model =
    typeof metadata.model === "string" && metadata.model.trim().length > 0
      ? metadata.model.trim()
      : undefined;
  const maxAgentDepth = parseOptionalNumber(metadata.maxAgentDepth);

  return {
    id,
    name,
    description,
    systemPrompt,
    agentTypes,
    ...(toolsAllowlist ? { toolsAllowlist } : {}),
    ...(model ? { model } : {}),
    ...(typeof maxAgentDepth === "number" ? { maxAgentDepth } : {}),
  };
};

export const loadParsedAgentsFromDir = (
  dir: string | URL,
  options: { allowMetadataOnly?: boolean } = {},
): ParsedAgent[] => {
  // Convert `file://` URLs to a native filesystem path with `fileURLToPath`,
  // not `URL.pathname`. On Windows `.pathname` is `/C:/Users/.../agents/`
  // (leading slash before the drive, plus URL-encoded chars like `%20`),
  // which `path.join` turns into an invalid path so every `readFileSync`
  // throws and the loader silently returns no agents.
  const rootDir = dir instanceof URL ? fileURLToPath(dir) : dir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: ParsedAgent[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(rootDir, entry.name);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = normalizeAgent(
        filePath,
        content,
        options.allowMetadataOnly === true,
      );
      if (parsed) {
        agents.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return agents;
};
