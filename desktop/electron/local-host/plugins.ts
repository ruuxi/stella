import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type { ParsedAgent, ParsedSkill } from "./manifests.js";
import { parseAgentMarkdown, parseSkillMarkdown } from "./manifests.js";

type ToolResult = {
  result?: unknown;
  error?: string;
};

type ToolContext = {
  conversationId: string;
  deviceId: string;
  requestId: string;
};

type PluginToolSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, PluginToolSchema>;
  required?: string[];
  items?: PluginToolSchema;
  enum?: string[];
};

type PluginToolManifest = {
  name?: string;
  description?: string;
  inputSchema?: PluginToolSchema;
  handler?: string;
};

type PluginManifest = {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  tools?: PluginToolManifest[];
  skills?: string[];
  agents?: string[];
};

export type PluginRecord = {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: string;
};

export type PluginToolDescriptor = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: PluginToolSchema;
  source: string;
};

type PluginLoadResult = {
  plugins: PluginRecord[];
  tools: PluginToolDescriptor[];
  skills: ParsedSkill[];
  agents: ParsedAgent[];
  handlers: Map<string, (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>>;
};

const DEFAULT_SCHEMA: PluginToolSchema = {
  type: "object",
  properties: {},
  required: [],
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readJson = async (filePath: string) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const loadPluginManifest = async (pluginDir: string) => {
  const manifestPath = path.join(pluginDir, "plugin.json");
  const parsed = await readJson(manifestPath);
  if (!isObjectRecord(parsed)) {
    return null;
  }
  return parsed as PluginManifest;
};

const normalizePluginId = (pluginDir: string, manifest: PluginManifest) => {
  if (typeof manifest.id === "string" && manifest.id.trim()) {
    return manifest.id.trim();
  }
  return path.basename(pluginDir);
};

const normalizePluginName = (pluginId: string, manifest: PluginManifest) => {
  if (typeof manifest.name === "string" && manifest.name.trim()) {
    return manifest.name.trim();
  }
  return pluginId;
};

const normalizePluginVersion = (manifest: PluginManifest) =>
  typeof manifest.version === "string" && manifest.version.trim()
    ? manifest.version.trim()
    : "0.0.0";

const normalizeSchema = (schema: PluginToolSchema | undefined): PluginToolSchema => {
  if (!schema || typeof schema !== "object") {
    return DEFAULT_SCHEMA;
  }

  // Ensure the tool schema remains a top-level object shape.
  const type = schema.type === "object" ? "object" : "object";
  const properties = isObjectRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];

  return {
    ...schema,
    type,
    properties,
    required,
  };
};

const loadHandler = async (
  pluginDir: string,
  handlerPath: string,
): Promise<((args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>) | null> => {
  const resolvedPath = path.resolve(pluginDir, handlerPath);
  try {
    const moduleUrl = pathToFileURL(resolvedPath).toString();
    const imported = (await import(moduleUrl)) as Record<string, unknown>;

    const candidate = imported.default ?? imported.handler ?? imported.run;
    if (typeof candidate !== "function") {
      return null;
    }

    return async (args, context) => {
      try {
        const result = await candidate(args, context);
        if (isObjectRecord(result) && ("result" in result || "error" in result)) {
          return result as ToolResult;
        }
        return { result };
      } catch (error) {
        return { error: `Plugin handler failed: ${(error as Error).message}` };
      }
    };
  } catch (error) {
    return async () => ({ error: `Failed to load handler: ${(error as Error).message}` });
  }
};

const loadPluginSkills = async (pluginDir: string, pluginId: string, skills: string[]) => {
  const parsed: ParsedSkill[] = [];
  for (const relativePath of skills) {
    const filePath = path.resolve(pluginDir, relativePath);
    const skill = await parseSkillMarkdown(filePath, `plugin:${pluginId}`);
    if (skill) parsed.push(skill);
  }
  return parsed;
};

const loadPluginAgents = async (pluginDir: string, pluginId: string, agents: string[]) => {
  const parsed: ParsedAgent[] = [];
  for (const relativePath of agents) {
    const filePath = path.resolve(pluginDir, relativePath);
    const agent = await parseAgentMarkdown(filePath, `plugin:${pluginId}`);
    if (agent) parsed.push(agent);
  }
  return parsed;
};

export const loadPluginsFromHome = async (pluginsPath: string): Promise<PluginLoadResult> => {
  const handlers = new Map<
    string,
    (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
  >();

  const plugins: PluginRecord[] = [];
  const tools: PluginToolDescriptor[] = [];
  const skills: ParsedSkill[] = [];
  const agents: ParsedAgent[] = [];

  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(pluginsPath, { withFileTypes: true });
  } catch {
    return { plugins, tools, skills, agents, handlers };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsPath, entry.name);
    const manifest = await loadPluginManifest(pluginDir);
    if (!manifest) continue;

    const pluginId = normalizePluginId(pluginDir, manifest);
    const pluginName = normalizePluginName(pluginId, manifest);
    const pluginVersion = normalizePluginVersion(manifest);

    plugins.push({
      id: pluginId,
      name: pluginName,
      version: pluginVersion,
      description: typeof manifest.description === "string" ? manifest.description : undefined,
      source: "local",
    });

    const toolManifests = Array.isArray(manifest.tools) ? manifest.tools : [];
    for (const toolManifest of toolManifests) {
      const toolName = typeof toolManifest.name === "string" ? toolManifest.name.trim() : "";
      if (!toolName) continue;

      const descriptor: PluginToolDescriptor = {
        pluginId,
        name: toolName,
        description:
          typeof toolManifest.description === "string" && toolManifest.description.trim()
            ? toolManifest.description.trim()
            : `Plugin tool: ${toolName}`,
        inputSchema: normalizeSchema(toolManifest.inputSchema),
        source: "local",
      };
      tools.push(descriptor);

      const handlerPath =
        typeof toolManifest.handler === "string" && toolManifest.handler.trim()
          ? toolManifest.handler.trim()
          : "";
      if (!handlerPath) {
        handlers.set(toolName, async () => ({ error: `Tool ${toolName} has no handler.` }));
        continue;
      }

      const handler = await loadHandler(pluginDir, handlerPath);
      if (handler) {
        handlers.set(toolName, handler);
      }
    }

    const skillPaths = Array.isArray(manifest.skills)
      ? manifest.skills.filter((value): value is string => typeof value === "string")
      : [];
    if (skillPaths.length > 0) {
      const parsedSkills = await loadPluginSkills(pluginDir, pluginId, skillPaths);
      skills.push(...parsedSkills);
    }

    const agentPaths = Array.isArray(manifest.agents)
      ? manifest.agents.filter((value): value is string => typeof value === "string")
      : [];
    if (agentPaths.length > 0) {
      const parsedAgents = await loadPluginAgents(pluginDir, pluginId, agentPaths);
      agents.push(...parsedAgents);
    }
  }

  return { plugins, tools, skills, agents, handlers };
};
