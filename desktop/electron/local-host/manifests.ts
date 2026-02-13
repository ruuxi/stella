import { promises as fs } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

type FrontmatterParseResult = {
  metadata: Record<string, unknown>;
  body: string;
};

const FRONTMATTER_DELIM = "---";

type StellaYamlData = {
  id?: string;
  name?: string;
  description?: string;
  agentTypes?: string[];
  version?: number;
  source?: string;
  importedAt?: number;
  enabled?: boolean;
};

const readStellaYaml = async (skillDir: string): Promise<StellaYamlData | null> => {
  const stellaYamlPath = path.join(skillDir, "stella.yaml");
  try {
    const content = await fs.readFile(stellaYamlPath, "utf-8");
    const parsed = parseYaml(content);
    if (parsed && typeof parsed === "object") {
      return parsed as StellaYamlData;
    }
  } catch {
    // stella.yaml doesn't exist or is invalid
  }
  return null;
};

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
  execution?: "backend" | "device";
  requiresSecrets?: string[];
  publicIntegration?: boolean;
  secretMounts?: {
    env?: Record<string, { provider: string; label?: string; description?: string; placeholder?: string }>;
    files?: Record<string, { provider: string; label?: string; description?: string; placeholder?: string }>;
  };
  enabled?: boolean;
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

type SecretMountSpec = {
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
};

const normalizeSecretMountMap = (
  value: unknown,
): Record<string, SecretMountSpec> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, SecretMountSpec> = {};

  for (const [key, raw] of entries) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (typeof raw === "string") {
      result[key] = { provider: raw };
      continue;
    }
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const provider = typeof record.provider === "string" ? record.provider.trim() : "";
      if (!provider) continue;
      result[key] = {
        provider,
        label: typeof record.label === "string" ? record.label : undefined,
        description: typeof record.description === "string" ? record.description : undefined,
        placeholder: typeof record.placeholder === "string" ? record.placeholder : undefined,
      };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

const normalizeSecretMounts = (
  value: unknown,
):
  | {
      env?: Record<string, SecretMountSpec>;
      files?: Record<string, SecretMountSpec>;
    }
  | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const env = normalizeSecretMountMap(record.env);
  const files = normalizeSecretMountMap(record.files);
  if (!env && !files) return undefined;
  return {
    env,
    files,
  };
};

const ENV_HINTS = ["_KEY", "_TOKEN", "_SECRET", "CLIENT_ID", "CLIENT_SECRET"];

const extractEnvVars = (text: string) => {
  const matches = text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
  const result = new Set<string>();
  for (const match of matches) {
    if (!ENV_HINTS.some((hint) => match.includes(hint))) continue;
    if (match.endsWith("_FILE") || match.endsWith("_PATH") || match.endsWith("_DIR")) {
      continue;
    }
    result.add(match);
  }
  return Array.from(result);
};

const extractTokenPaths = (text: string) => {
  const results = new Set<string>();
  const regex = /~\/\.config\/[^\s"'`]+\/token\b/g;
  const matches = text.match(regex) ?? [];
  for (const match of matches) {
    results.add(match);
  }
  return Array.from(results);
};

const providerFromTokenPath = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const dir = parts.length > 1 ? parts[parts.length - 2] : "token";
  return `${dir}_token`;
};

const deriveSecretMountsFromMarkdown = (markdown: string) => {
  const envVars = extractEnvVars(markdown);
  const tokenPaths = extractTokenPaths(markdown);

  const env: Record<string, SecretMountSpec> = {};
  for (const envVar of envVars) {
    env[envVar] = { provider: envVar, label: envVar };
  }

  const files: Record<string, SecretMountSpec> = {};
  for (const tokenPath of tokenPaths) {
    const provider = providerFromTokenPath(tokenPath);
    files[tokenPath] = {
      provider,
      label: provider.replace(/_/g, " "),
    };
  }

  if (Object.keys(env).length === 0 && Object.keys(files).length === 0) {
    return undefined;
  }
  return {
    env: Object.keys(env).length > 0 ? env : undefined,
    files: Object.keys(files).length > 0 ? files : undefined,
  };
};


export const parseSkillMarkdown = async (
  filePath: string,
  source: string,
): Promise<ParsedSkill | null> => {
  const raw = await readMarkdownFile(filePath);
  if (!raw) return null;

  const { metadata, body } = extractFrontmatter(raw);

  // Check for stella.yaml alongside SKILL.md (takes precedence over frontmatter)
  const skillDir = path.dirname(filePath);
  const stellaYaml = await readStellaYaml(skillDir);

  // Merge stella.yaml with frontmatter (stella.yaml wins)
  const id =
    (stellaYaml?.id && stellaYaml.id.trim()) ||
    (typeof metadata.id === "string" && metadata.id.trim()) ||
    deriveIdFromPath(filePath);
  const name =
    (stellaYaml?.name && stellaYaml.name.trim()) ||
    (typeof metadata.name === "string" && metadata.name.trim()) ||
    id;
  const description =
    (stellaYaml?.description && stellaYaml.description.trim()) ||
    (typeof metadata.description === "string" && metadata.description.trim()) ||
    "Skill instructions.";

  // Prefer stella.yaml agentTypes if present
  const agentTypes =
    stellaYaml?.agentTypes && stellaYaml.agentTypes.length > 0
      ? stellaYaml.agentTypes
      : normalizeStringArray(metadata.agentTypes);
  const toolsAllowlist = normalizeStringArray(metadata.toolsAllowlist);
  const tags = normalizeStringArray(metadata.tags);
  const requiresSecrets = normalizeStringArray(metadata.requiresSecrets);
  const execution =
    metadata.execution === "backend" || metadata.execution === "device"
      ? (metadata.execution as "backend" | "device")
      : undefined;
  const publicIntegration =
    typeof metadata.publicIntegration === "boolean" ? metadata.publicIntegration : undefined;
  const hasSecretMounts =
    Object.prototype.hasOwnProperty.call(metadata, "secretMounts");
  const explicitSecretMounts = normalizeSecretMounts(metadata.secretMounts);
  const inferredSecretMounts = hasSecretMounts ? undefined : deriveSecretMountsFromMarkdown(body);
  const secretMounts = explicitSecretMounts ?? inferredSecretMounts;

  const mergedRequires = new Set(requiresSecrets);
  if (secretMounts?.env) {
    for (const spec of Object.values(secretMounts.env)) {
      mergedRequires.add(spec.provider);
    }
  }
  if (secretMounts?.files) {
    for (const spec of Object.values(secretMounts.files)) {
      mergedRequires.add(spec.provider);
    }
  }
  const derivedRequires = Array.from(mergedRequires).filter((value) => value.trim().length > 0);

  // Read enabled from stella.yaml (undefined means default — backend treats as true)
  const enabled =
    stellaYaml && typeof stellaYaml.enabled === "boolean"
      ? stellaYaml.enabled
      : undefined;

  return {
    id,
    name,
    description,
    markdown: body.trim() ? body : raw,
    agentTypes,
    toolsAllowlist: toolsAllowlist.length > 0 ? toolsAllowlist : undefined,
    tags: tags.length > 0 ? tags : undefined,
    execution,
    requiresSecrets: derivedRequires.length > 0 ? derivedRequires : undefined,
    publicIntegration,
    secretMounts,
    enabled,
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
