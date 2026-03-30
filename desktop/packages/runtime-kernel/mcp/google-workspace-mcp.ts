import { existsSync } from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { createRuntimeLogger } from "../debug.js";
import {
  getGoogleWorkspaceMcpToolAliases,
  isAllowedGoogleWorkspaceMcpTool,
} from "./google-workspace-allowlist.js";
import {
  clearMcpToolMetadata,
  registerMcpToolMetadata,
} from "./mcp-tool-metadata-registry.js";
import { resolveGoogleWorkspaceMcpEntry } from "./resolve-google-workspace-mcp-entry.js";

const logger = createRuntimeLogger("google-workspace-mcp");

const jsonSchemaToParameters = (
  schema: unknown,
): Record<string, unknown> => {
  if (schema && typeof schema === "object") {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
};

const stringifyGoogleWorkspaceError = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
  }

  if (value == null) {
    return null;
  }

  try {
    const text = JSON.stringify(value);
    return text && text !== "{}" ? text : null;
  } catch {
    return String(value);
  }
};

const getGoogleWorkspaceJsonError = (text: string): string | null => {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return stringifyGoogleWorkspaceError(
      (parsed as Record<string, unknown>).error,
    );
  } catch {
    return null;
  }
};

export const formatGoogleWorkspaceCallToolResult = (
  result: unknown,
): ToolResult => {
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const parts =
    r.content?.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    }) ?? [];

  const text = parts.join("\n").trim();
  const jsonError = getGoogleWorkspaceJsonError(text);

  if (r.isError || jsonError) {
    return {
      error:
        (jsonError ?? text) || "Google Workspace tool returned an error.",
    };
  }
  return { result: text || "(empty result)" };
};

export type McpCallToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

const AUTH_ERROR_PATTERN = /\bauth\b|oauth|sign[._-]?in|login|consent|credential|unauthorized|unauthenticated|\b403\b|\b401\b/i;

const AUTH_REQUIRED_DEBOUNCE_MS = 10_000;

export const loadGoogleWorkspaceMcpTools = async (options: {
  frontendRoot?: string;
  onAuthRequired?: () => void;
  onAuthStateChanged?: (authenticated: boolean) => void;
}): Promise<{
  tools: ToolDefinition[];
  disconnect: () => Promise<void>;
  callTool: McpCallToolFn | null;
  hasStoredCredentials: boolean;
}> => {
  const entryPath = resolveGoogleWorkspaceMcpEntry(options.frontendRoot);
  if (!entryPath) {
    logger.warn("google_workspace.mcp.missing", {
      message:
        "Google Workspace MCP server not found. Run `npm run vendor:google-workspace-mcp` in desktop/ or set STELLA_GOOGLE_WORKSPACE_MCP_PATH.",
    });
    return {
      tools: [],
      disconnect: async () => {
        clearMcpToolMetadata();
      },
      callTool: null,
      hasStoredCredentials: false,
    };
  }

  const client = new Client({
    name: "stella-desktop",
    version: "0.0.0",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
  });

  await client.connect(transport);

  const listed = await client.listTools();
  const toolsOut: ToolDefinition[] = [];
  const toolNameAliases = new Map<string, string>();

  const resolveToolName = (name: string): string =>
    toolNameAliases.get(name) ?? name;

  let lastAuthRequiredAt = 0;
  const notifyAuthRequired = () => {
    const now = Date.now();
    if (now - lastAuthRequiredAt < AUTH_REQUIRED_DEBOUNCE_MS) return;
    lastAuthRequiredAt = now;
    options.onAuthRequired?.();
  };

  const callGoogleWorkspaceTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    try {
      const result = await client.callTool({
        name: resolveToolName(name),
        arguments: args,
      });
      const formatted = formatGoogleWorkspaceCallToolResult(result);
      if ("error" in formatted && AUTH_ERROR_PATTERN.test(formatted.error ?? "")) {
        notifyAuthRequired();
        options.onAuthStateChanged?.(false);
      } else if (!("error" in formatted)) {
        options.onAuthStateChanged?.(true);
      }
      return formatted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (AUTH_ERROR_PATTERN.test(message)) {
        notifyAuthRequired();
        options.onAuthStateChanged?.(false);
      }
      return { error: `Google Workspace tool failed: ${message}` };
    }
  };

  for (const tool of listed.tools ?? []) {
    if (!isAllowedGoogleWorkspaceMcpTool(tool.name)) {
      continue;
    }

    for (const alias of getGoogleWorkspaceMcpToolAliases(tool.name)) {
      toolNameAliases.set(alias, tool.name);
    }

    const description =
      typeof tool.description === "string" && tool.description.trim()
        ? tool.description
        : `Google Workspace: ${tool.name}`;

    const parameters = jsonSchemaToParameters(tool.inputSchema);

    registerMcpToolMetadata(tool.name, description, parameters);

    const toolName = tool.name;
    const execute = async (
      args: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> => callGoogleWorkspaceTool(toolName, args);

    toolsOut.push({
      name: tool.name,
      description,
      agentTypes: ["google_workspace"],
      parameters,
      execute,
    });
  }

  logger.info("google_workspace.mcp.ready", {
    toolCount: toolsOut.length,
    entryPath,
  });

  const disconnect = async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
    clearMcpToolMetadata();
  };

  // Check for stored credentials next to the project root (the directory
  // containing gemini-extension.json, two levels above workspace-server/dist/).
  const tokenRoot = path.resolve(path.dirname(entryPath), "..", "..");
  const tokenFilePath = path.join(tokenRoot, "gemini-cli-workspace-token.json");
  const hasStoredCredentials = existsSync(tokenFilePath);

  return { tools: toolsOut, disconnect, callTool: callGoogleWorkspaceTool, hasStoredCredentials };
};
