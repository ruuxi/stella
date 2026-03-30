import { existsSync, mkdirSync, writeFileSync, copyFileSync, statSync } from "fs";
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

/**
 * Ensure the MCP server's writable data directory exists in the user's Stella
 * home. The upstream server resolves its "project root" by walking up from
 * __dirname looking for gemini-extension.json, then stores OAuth tokens and a
 * master key alongside it. In packaged builds the bundled resources directory is
 * read-only, so we copy the bundled entry into writable user data. Running the
 * copy makes __dirname naturally point to the writable directory.
 *
 * Layout:
 *   <stellaHome>/google-workspace-mcp/
 *     gemini-extension.json              ← project-root marker (walk-up target)
 *     gemini-cli-workspace-token.json    ← written by upstream server at runtime
 *     .gemini-cli-workspace-master-key   ← written by upstream server at runtime
 *     workspace-server/dist/
 *       index.js                         ← copy of the bundled entry
 */
const ensureGoogleWorkspaceMcpDataDir = (
  stellaHomePath: string,
  bundledEntryPath: string,
): { entryPath: string; dataDir: string } => {
  const dataDir = path.join(stellaHomePath, "google-workspace-mcp");
  const distDir = path.join(dataDir, "workspace-server", "dist");
  mkdirSync(distDir, { recursive: true });

  // Place gemini-extension.json so the server's walk-up finds the writable root.
  const extensionJsonPath = path.join(dataDir, "gemini-extension.json");
  if (!existsSync(extensionJsonPath)) {
    const bundledRoot = path.resolve(path.dirname(bundledEntryPath), "..", "..");
    const bundledExtJson = path.join(bundledRoot, "gemini-extension.json");
    if (existsSync(bundledExtJson)) {
      copyFileSync(bundledExtJson, extensionJsonPath);
    } else {
      writeFileSync(
        extensionJsonPath,
        JSON.stringify({ name: "google-workspace", version: "0.0.0" }, null, 2) + "\n",
      );
    }
  }

  // Copy the bundled entry so __dirname resolves to the writable directory.
  // Re-copy only when the bundled file is newer (i.e. after an app update).
  const localEntry = path.join(distDir, "index.js");
  let needsCopy = !existsSync(localEntry);
  if (!needsCopy) {
    try {
      const bundledMtime = statSync(bundledEntryPath).mtimeMs;
      const localMtime = statSync(localEntry).mtimeMs;
      needsCopy = bundledMtime > localMtime;
    } catch {
      needsCopy = true;
    }
  }
  if (needsCopy) {
    copyFileSync(bundledEntryPath, localEntry);
  }

  return { entryPath: localEntry, dataDir };
};

export const loadGoogleWorkspaceMcpTools = async (options: {
  frontendRoot?: string;
  stellaHomePath?: string;
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

  // When stellaHomePath is available, set up a writable data directory so the
  // upstream server can persist OAuth tokens outside read-only app resources.
  let serverEntryPath = entryPath;
  let dataDir: string | null = null;
  if (options.stellaHomePath) {
    const setup = ensureGoogleWorkspaceMcpDataDir(options.stellaHomePath, entryPath);
    serverEntryPath = setup.entryPath;
    dataDir = setup.dataDir;
  }

  const client = new Client({
    name: "stella-desktop",
    version: "0.0.0",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntryPath],
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

  // Check for stored credentials. When using a writable data dir, tokens are
  // stored there; otherwise they're next to the bundled entry's project root.
  const tokenRoot = dataDir ?? path.resolve(path.dirname(entryPath), "..", "..");
  const tokenFilePath = path.join(tokenRoot, "gemini-cli-workspace-token.json");
  const hasStoredCredentials = existsSync(tokenFilePath);

  return { tools: toolsOut, disconnect, callTool: callGoogleWorkspaceTool, hasStoredCredentials };
};
