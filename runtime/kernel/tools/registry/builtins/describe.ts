/**
 * `tools.describe` — fetch the full descriptor for any registered tool the
 * agent is allowed to call. Used to inspect deferred tools (whose typed
 * signatures are omitted from the per-turn prompt to save tokens) or to
 * confirm an argument schema before calling.
 *
 * Returns the same shape the registry holds, plus a rendered TypeScript
 * signature line so the model has something readable to consume.
 */

import {
  renderJsonSchemaAsTypescript,
  type ExecToolDefinition,
  type ExecToolRegistry,
} from "../registry.js";

const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Tool name as it appears in `ALL_TOOLS` (e.g. 'read_file', 'apply_patch').",
    },
  },
  required: ["name"],
} as const;

export type DescribeBuiltinOptions = {
  registry: ExecToolRegistry;
};

const renderSignature = (tool: ExecToolDefinition): string => {
  const inputType = renderJsonSchemaAsTypescript(tool.inputSchema);
  const outputType = tool.outputSchema
    ? renderJsonSchemaAsTypescript(tool.outputSchema)
    : "unknown";
  return `tools.${tool.name}(args: ${inputType}): Promise<${outputType}>`;
};

export const createDescribeBuiltin = (
  options: DescribeBuiltinOptions,
): ExecToolDefinition => ({
  name: "describe",
  description:
    "Return the full descriptor (TypeScript signature, JSON Schema, one-line description) for a registered tool. Use this to inspect deferred tools you discovered through `ALL_TOOLS` before calling them.",
  inputSchema: DESCRIBE_SCHEMA,
  handler: async (rawArgs, context) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const name = String(args.name ?? "").trim();
    if (!name) throw new Error("name is required.");

    const tool = options.registry.get(name);
    if (!tool) {
      throw new Error(
        `No tool named '${name}'. Filter ALL_TOOLS by name/description to find available tools.`,
      );
    }

    // Apply the same agentTypes filter the prompt uses so `describe` can't
    // be a backdoor for tools an agent isn't allowed to call.
    const agentType = context.agentType;
    if (
      tool.agentTypes &&
      agentType &&
      !tool.agentTypes.includes(agentType)
    ) {
      throw new Error(`Tool '${name}' is not available to this agent.`);
    }

    return {
      name: tool.name,
      description: tool.description,
      signature: renderSignature(tool),
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      deferred: Boolean(tool.defer),
    };
  },
});
