/**
 * Codex-style tool registry that backs the `tools.*` global inside `Exec`.
 *
 * Each registered tool is the unit of extensibility: a single description,
 * JSON Schema for inputs (and optional outputs), and an async handler. The
 * registry is the single source of truth for both:
 *
 * - the `tools` proxy installed inside the worker context, and
 * - the prompt-side typed declarations in the `Exec` tool description.
 */

import type { ToolContext } from "../types.js";

export type ExecToolKind = "function" | "freeform";

export type ExecContentItem =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export type ExecToolHandlerExtras = {
  signal?: AbortSignal;
  /**
   * Cell id of the running `Exec` invocation that issued this tool call. The
   * registry guarantees this is always a stable identifier per run.
   */
  cellId: string;
};

export type ExecToolHandler = (
  args: unknown,
  context: ToolContext,
  extras: ExecToolHandlerExtras,
) => Promise<unknown>;

export type ExecToolDefinition = {
  name: string;
  description: string;
  kind?: ExecToolKind;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /**
   * Optional access filter. When omitted, the tool is exposed to every agent.
   * When present, only agents whose `agentType` is included in the array see
   * the tool inside their `tools.*` namespace and prompt description.
   */
  agentTypes?: readonly string[];
  /**
   * When true, the tool's full typed signature is omitted from the per-turn
   * prompt to save tokens. The tool is still callable via `tools.<name>`
   * and listed in `ALL_TOOLS` so the agent can discover it on demand and
   * fetch its schema with `tools.describe({ name })`.
   *
   * Use this for high-fan-out surfaces (MCP servers, extension tool packs,
   * many-method APIs) where listing every signature would dwarf the rest of
   * the prompt.
   */
  defer?: boolean;
  handler: ExecToolHandler;
};

export type ExecToolRegistrySnapshot = {
  tools: ExecToolDefinition[];
};

export type ExecToolRegistry = {
  register(tool: ExecToolDefinition): void;
  registerMany(tools: readonly ExecToolDefinition[]): void;
  unregister(name: string): boolean;
  has(name: string): boolean;
  get(name: string): ExecToolDefinition | undefined;
  list(filter?: { agentType?: string }): ExecToolDefinition[];
};

export const isExecToolAvailableToAgent = (
  tool: ExecToolDefinition,
  agentType?: string,
): boolean =>
  !tool.agentTypes ||
  (typeof agentType === "string" && tool.agentTypes.includes(agentType));

export const createExecToolRegistry = (
  initialTools: readonly ExecToolDefinition[] = [],
): ExecToolRegistry => {
  const byName = new Map<string, ExecToolDefinition>();

  const register = (tool: ExecToolDefinition) => {
    if (!tool.name || typeof tool.name !== "string") {
      throw new Error("ExecToolRegistry.register requires a non-empty tool name.");
    }
    if (!tool.description || typeof tool.description !== "string") {
      throw new Error(
        `ExecToolRegistry.register requires a description for tool '${tool.name}'.`,
      );
    }
    if (typeof tool.handler !== "function") {
      throw new Error(
        `ExecToolRegistry.register requires a handler for tool '${tool.name}'.`,
      );
    }
    byName.set(tool.name, tool);
  };

  for (const tool of initialTools) {
    register(tool);
  }

  return {
    register,
    registerMany(tools) {
      for (const tool of tools) {
        register(tool);
      }
    },
    unregister(name) {
      return byName.delete(name);
    },
    has(name) {
      return byName.has(name);
    },
    get(name) {
      return byName.get(name);
    },
    list(filter) {
      const agentType = filter?.agentType;
      const tools: ExecToolDefinition[] = [];
      for (const tool of byName.values()) {
        if (!isExecToolAvailableToAgent(tool, agentType)) {
          continue;
        }
        tools.push(tool);
      }
      return tools.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
};

/**
 * Renders a JSON Schema as a TypeScript type literal, used to populate the
 * typed declarations Stella ships in the `Exec` description so the model
 * knows the exact signature of each `tools.*` entry.
 *
 * This is intentionally permissive — it covers the schema shapes Stella
 * actually emits today (object/array/string/number/boolean/enum/oneOf/anyOf)
 * and falls back to `unknown` for anything more exotic.
 */
export const renderJsonSchemaAsTypescript = (
  schema: Record<string, unknown> | undefined,
): string => {
  if (!schema) {
    return "unknown";
  }
  const result = renderSchema(schema, 0);
  return result.length > 0 ? result : "unknown";
};

const INDENT_UNIT = "  ";

const indent = (level: number) => INDENT_UNIT.repeat(level);

const renderSchema = (raw: unknown, level: number): string => {
  if (!raw || typeof raw !== "object") {
    return "unknown";
  }
  const schema = raw as Record<string, unknown>;

  if (Array.isArray(schema.enum)) {
    const literals = (schema.enum as unknown[])
      .map((value) => JSON.stringify(value))
      .filter((value) => typeof value === "string");
    if (literals.length > 0) {
      return literals.join(" | ");
    }
  }

  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const variants = (schema.oneOf ?? schema.anyOf) as unknown[];
    const rendered = variants
      .map((entry) => renderSchema(entry, level))
      .filter((entry) => entry && entry !== "unknown");
    if (rendered.length > 0) {
      return rendered.join(" | ");
    }
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return type
      .map((entry) =>
        renderSchema({ ...schema, type: entry }, level),
      )
      .join(" | ");
  }

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = (schema.items ?? {}) as Record<string, unknown>;
      const inner = renderSchema(items, level);
      return inner.includes(" | ") ? `Array<${inner}>` : `${inner}[]`;
    }
    case "object":
    case undefined: {
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      const required = new Set<string>(
        Array.isArray(schema.required)
          ? (schema.required as string[]).filter(
              (entry) => typeof entry === "string",
            )
          : [],
      );
      const propertyEntries = Object.entries(properties);
      if (propertyEntries.length === 0) {
        return "Record<string, unknown>";
      }
      const lines = propertyEntries.map(([key, value]) => {
        const optional = required.has(key) ? "" : "?";
        const inner = renderSchema(value, level + 1);
        const description =
          value && typeof value === "object" && "description" in value
            ? String((value as Record<string, unknown>).description ?? "").trim()
            : "";
        const comment = description
          ? `${indent(level + 1)}/** ${description.replace(/\n/g, " ").slice(0, 200)} */\n`
          : "";
        return `${comment}${indent(level + 1)}${formatPropertyKey(key)}${optional}: ${inner};`;
      });
      return `{\n${lines.join("\n")}\n${indent(level)}}`;
    }
    default:
      return "unknown";
  }
};

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const formatPropertyKey = (key: string): string =>
  SAFE_KEY.test(key) ? key : JSON.stringify(key);
