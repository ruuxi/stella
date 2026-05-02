import { AGENT_IDS } from "../../../../desktop/src/shared/contracts/agent-runtime.js";
import { callApiConnector } from "../../mcp/api-client.js";
import { callMcpServerTool, listMcpServerTools } from "../../mcp/client.js";
import { getOfficialConnector } from "../../mcp/official-connectors.js";
import {
  installOfficialConnector,
  listConfiguredApiConnectors,
  listConfiguredMcpServers,
  listStellaConnectors,
  officialConnectorRequiresSetup,
} from "../../mcp/state.js";
import type { McpServerConfig } from "../../mcp/types.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolUpdateCallback,
} from "../types.js";
import { createComputerTools } from "./computer.js";

const requireGeneral = (agentType?: string) => {
  if (agentType && agentType !== AGENT_IDS.GENERAL) {
    throw new Error("MCP is available to the General agent only.");
  }
};

const findServer = async (stellaRoot: string, serverId: string) => {
  const servers = await listConfiguredMcpServers(stellaRoot);
  const server = servers.find((entry) => entry.id === serverId);
  if (!server) throw new Error(`MCP server is not installed: ${serverId}`);
  return server;
};

const findApi = async (stellaRoot: string, apiId: string) => {
  const apis = await listConfiguredApiConnectors(stellaRoot);
  const api = apis.find((entry) => entry.id === apiId);
  if (!api) throw new Error(`API connector is not installed: ${apiId}`);
  return api;
};

const summarizeServer = (server: McpServerConfig) => ({
  id: server.id,
  displayName: server.displayName,
  description: server.description,
  transport: server.transport,
  url: server.url,
  auth: server.auth?.type ?? "none",
  source: server.source,
});

const COMPUTER_USE_SERVER_ID = "computer-use";

const computerUseToolCatalog = () =>
  createComputerTools({}).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

const isComputerUseTool = (toolName: string) =>
  toolName.startsWith("computer_") &&
  computerUseToolCatalog().some((tool) => tool.name === toolName);

export const createMcpTool = (options: {
  stellaRoot: string;
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
}): ToolDefinition => ({
  name: "MCP",
  description:
    "Discover, install, inspect, and call Stella Connect MCP integrations on demand. Use this instead of assuming all connector tools are preloaded.",
  promptSnippet:
    "Use MCP to discover installed Stella Connect integrations, inspect their tools, and call a selected integration.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["connectors", "install", "servers", "tools", "call", "apis", "api_call"],
      },
      connector: {
        type: "string",
        description: "Marketplace key for install, such as attio or amplitude.",
      },
      server: {
        type: "string",
        description:
          "Installed MCP server id, API connector id, or local deferred tool group such as computer-use.",
      },
      tool: {
        type: "string",
        description: "MCP tool name for call.",
      },
      arguments: {
        type: "object",
        description: "Arguments for the selected MCP tool.",
        additionalProperties: true,
      },
      path: {
        type: "string",
        description: "API path for api_call, such as /v3/time.",
      },
      method: {
        type: "string",
        description: "HTTP method for api_call.",
      },
      query: {
        type: "object",
        description: "Query string parameters for api_call.",
        additionalProperties: true,
      },
    },
    required: ["action"],
  },
  execute: async (args, context, extras) => {
    try {
      requireGeneral(context.agentType);
      const action = String(args.action ?? "");
      if (action === "connectors") {
        return { result: await listStellaConnectors(options.stellaRoot) };
      }
      if (action === "install") {
        const connector = String(args.connector ?? "").trim();
        if (!connector) return { error: "connector is required." };
        const official = getOfficialConnector(connector);
        if (!official) {
          return { error: `Unknown Stella Connect connector: ${connector}` };
        }
        if (officialConnectorRequiresSetup(official)) {
          return {
            error:
              `${official.displayName} needs credential or OAuth setup. ` +
              "Install it from Store > Connect so Stella can collect credentials before marking it installed.",
          };
        }
        const installed = await installOfficialConnector(options.stellaRoot, connector);
        return {
          result: {
            installedServers: installed.servers.map(summarizeServer),
            installedApis: installed.apis.map((api) => ({
              id: api.id,
              displayName: api.displayName,
              description: api.description,
              baseUrl: api.baseUrl,
              auth: api.auth?.type ?? "none",
              source: api.source,
            })),
          },
        };
      }
      if (action === "servers") {
        const servers = await listConfiguredMcpServers(options.stellaRoot);
        return {
          result: [
            {
              id: COMPUTER_USE_SERVER_ID,
              displayName: "Computer Use",
              description:
                "Local deferred tools for inspecting and controlling desktop apps through Stella computer-use automation.",
              transport: "local",
              auth: "none",
              source: "builtin",
            },
            ...servers.map(summarizeServer),
          ],
        };
      }
      if (action === "apis") {
        const apis = await listConfiguredApiConnectors(options.stellaRoot);
        return {
          result: apis.map((api) => ({
            id: api.id,
            displayName: api.displayName,
            description: api.description,
            baseUrl: api.baseUrl,
            auth: api.auth?.type ?? "none",
            source: api.source,
          })),
        };
      }
      if (action === "tools") {
        const serverId = String(args.server ?? "").trim();
        if (!serverId) return { error: "server is required." };
        if (serverId === COMPUTER_USE_SERVER_ID) {
          return { result: computerUseToolCatalog() };
        }
        const server = await findServer(options.stellaRoot, serverId);
        return { result: await listMcpServerTools(options.stellaRoot, server) };
      }
      if (action === "call") {
        const serverId = String(args.server ?? "").trim();
        const toolName = String(args.tool ?? "").trim();
        if (!serverId) return { error: "server is required." };
        if (!toolName) return { error: "tool is required." };
        if (serverId === COMPUTER_USE_SERVER_ID) {
          if (!isComputerUseTool(toolName)) {
            return {
              error: `Unknown computer-use tool: ${toolName}`,
            };
          }
          return await options.executeTool(
            toolName,
            (args.arguments && typeof args.arguments === "object"
              ? args.arguments
              : {}) as Record<string, unknown>,
            context,
            extras?.signal,
            extras?.onUpdate,
          );
        }
        const server = await findServer(options.stellaRoot, serverId);
        return {
          result: await callMcpServerTool(
            options.stellaRoot,
            server,
            toolName,
            (args.arguments && typeof args.arguments === "object"
              ? args.arguments
              : {}) as Record<string, unknown>,
          ),
        };
      }
      if (action === "api_call") {
        const apiId = String(args.server ?? "").trim();
        const path = String(args.path ?? "").trim();
        if (!apiId) return { error: "server is required for api_call." };
        if (!path) return { error: "path is required for api_call." };
        const api = await findApi(options.stellaRoot, apiId);
        return {
          result: await callApiConnector(options.stellaRoot, api, {
            method: typeof args.method === "string" ? args.method : undefined,
            path,
            query: (args.query && typeof args.query === "object"
              ? args.query
              : undefined) as Record<string, string | number | boolean> | undefined,
            body: args.arguments,
          }),
        };
      }
      return { error: `Unknown MCP action: ${action}` };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
