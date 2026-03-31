/**
 * Loads Google Workspace tools directly via googleapis (no MCP subprocess).
 *
 * @license
 * Portions Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRuntimeLogger } from "../debug.js";
import { GOOGLE_WORKSPACE_MCP_TOOL_ALLOWLIST } from "../mcp/google-workspace-allowlist.js";
import {
  clearMcpToolMetadata,
  registerMcpToolMetadata,
} from "../mcp/mcp-tool-metadata-registry.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { setGoogleWorkspaceProjectRoot } from "./paths.js";
import { AuthManager } from "./AuthManager.js";
import { SCOPES } from "./scopes.js";
import { DriveService } from "./DriveService.js";
import { DocsService } from "./DocsService.js";
import { CalendarService } from "./CalendarService.js";
import { GmailService } from "./GmailService.js";
import { PeopleService } from "./PeopleService.js";
import { TimeService } from "./TimeService.js";
import { hasStoredCredentialsFile } from "./stella-credential-storage.js";
import { formatGoogleWorkspaceCallToolResult } from "./format-google-workspace-result.js";
import { GOOGLE_WORKSPACE_TOOL_METADATA } from "./google-workspace-tool-metadata.js";

const logger = createRuntimeLogger("google-workspace");

const AUTH_ERROR_PATTERN =
  /\bauth\b|oauth|sign[._-]?in|login|consent|credential|unauthorized|unauthenticated|\b403\b|\b401\b/i;

const AUTH_REQUIRED_DEBOUNCE_MS = 10_000;

export type GoogleWorkspaceCallToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

function buildHandlers(
  auth: AuthManager,
  drive: DriveService,
  docs: DocsService,
  calendar: CalendarService,
  gmail: GmailService,
  people: PeopleService,
  time: TimeService,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    "auth.clear": async () => {
      await auth.clearAuth();
      return {
        content: [
          {
            type: "text" as const,
            text: "Authentication credentials cleared. You will be prompted to log in again on the next request.",
          },
        ],
      };
    },
    "auth.refreshToken": async () => {
      await auth.refreshToken();
      return {
        content: [
          {
            type: "text" as const,
            text: "Token refresh process triggered successfully.",
          },
        ],
      };
    },
    "docs.getSuggestions": (args) =>
      docs.getSuggestions(args as { documentId: string }),
    "docs.getComments": async (args) => {
      const fileId =
        (typeof args.documentId === "string" && args.documentId) ||
        (typeof args.fileId === "string" && args.fileId) ||
        "";
      if (!fileId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "documentId or fileId is required.",
              }),
            },
          ],
        };
      }
      return drive.getComments({ fileId });
    },
    "docs.create": (args) =>
      docs.create(args as { title: string; content?: string }),
    "docs.writeText": (args) =>
      docs.writeText(
        args as {
          documentId: string;
          text: string;
          position?: string;
          tabId?: string;
        },
      ),
    "docs.getText": (args) =>
      docs.getText(args as { documentId: string; tabId?: string }),
    "docs.replaceText": (args) =>
      docs.replaceText(
        args as {
          documentId: string;
          findText: string;
          replaceText: string;
          tabId?: string;
        },
      ),
    "docs.formatText": (args) =>
      docs.formatText(
        args as {
          documentId: string;
          formats: {
            startIndex: number;
            endIndex: number;
            style: string;
            url?: string;
          }[];
          tabId?: string;
        },
      ),
    "drive.search": (args) => drive.search(args as Record<string, unknown>),
    "drive.findFolder": (args) =>
      drive.findFolder(args as { folderName: string }),
    "drive.createFolder": (args) =>
      drive.createFolder(
        args as { name: string; parentId?: string },
      ),
    "drive.downloadFile": (args) =>
      drive.downloadFile(
        args as { fileId: string; localPath: string },
      ),
    "drive.renameFile": (args) =>
      drive.renameFile(
        args as { fileId: string; newName: string },
      ),
    "calendar.list": () => calendar.listCalendars(),
    "calendar.createEvent": (args) =>
      calendar.createEvent(args as never),
    "calendar.listEvents": (args) =>
      calendar.listEvents(args as never),
    "calendar.getEvent": (args) =>
      calendar.getEvent(args as never),
    "calendar.findFreeTime": (args) =>
      calendar.findFreeTime(args as never),
    "calendar.updateEvent": (args) =>
      calendar.updateEvent(args as never),
    "calendar.respondToEvent": (args) =>
      calendar.respondToEvent(args as never),
    "gmail.search": (args) => gmail.search(args as never),
    "gmail.get": (args) => gmail.get(args as never),
    "gmail.downloadAttachment": (args) =>
      gmail.downloadAttachment(args as never),
    "gmail.modify": (args) => gmail.modify(args as never),
    "gmail.send": (args) => gmail.send(args as never),
    "gmail.createDraft": (args) =>
      gmail.createDraft(args as never),
    "gmail.sendDraft": (args) =>
      gmail.sendDraft(args as { draftId: string }),
    "gmail.listLabels": () => gmail.listLabels(),
    "gmail.createLabel": (args) =>
      gmail.createLabel(args as never),
    "time.getCurrentDate": () => time.getCurrentDate(),
    "time.getCurrentTime": () => time.getCurrentTime(),
    "time.getTimeZone": () => time.getTimeZone(),
    "people.getMe": () => people.getMe(),
  };
}

export const loadGoogleWorkspaceTools = async (options: {
  stellaHomePath: string;
  onAuthRequired?: () => void;
  onAuthStateChanged?: (authenticated: boolean) => void;
}): Promise<{
  tools: ToolDefinition[];
  disconnect: () => Promise<void>;
  callTool: GoogleWorkspaceCallToolFn | null;
  hasStoredCredentials: boolean;
}> => {
  const root = path.join(options.stellaHomePath, "google-workspace");
  await mkdir(root, { recursive: true, mode: 0o700 });
  setGoogleWorkspaceProjectRoot(root);

  const authManager = new AuthManager(SCOPES);
  const drive = new DriveService(authManager);
  const docs = new DocsService(authManager);
  const calendar = new CalendarService(authManager);
  const gmail = new GmailService(authManager);
  const people = new PeopleService(authManager);
  const time = new TimeService();
  const handlers = buildHandlers(
    authManager,
    drive,
    docs,
    calendar,
    gmail,
    people,
    time,
  );

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
      const handler = handlers[name];
      if (!handler) {
        return { error: `Unknown Google Workspace tool: ${name}` };
      }
      const raw = await handler(args);
      const formatted = formatGoogleWorkspaceCallToolResult(raw);
      if (
        "error" in formatted &&
        AUTH_ERROR_PATTERN.test(formatted.error ?? "")
      ) {
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

  const toolsOut: ToolDefinition[] = [];
  for (const toolName of GOOGLE_WORKSPACE_MCP_TOOL_ALLOWLIST) {
    const meta = GOOGLE_WORKSPACE_TOOL_METADATA[toolName];
    if (!meta) {
      logger.warn("google_workspace.missing_metadata", { toolName });
      continue;
    }
    if (!handlers[toolName]) {
      logger.warn("google_workspace.missing_handler", { toolName });
      continue;
    }

    registerMcpToolMetadata(toolName, meta.description, meta.parameters);

    const execute = async (
      executeArgs: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> => callGoogleWorkspaceTool(toolName, executeArgs);

    toolsOut.push({
      name: toolName,
      description: meta.description,
      agentTypes: ["google_workspace"],
      parameters: meta.parameters,
      execute,
    });
  }

  logger.info("google_workspace.direct.ready", {
    toolCount: toolsOut.length,
    dataRoot: root,
  });

  const disconnect = async () => {
    clearMcpToolMetadata();
  };

  const hasStoredCredentials = hasStoredCredentialsFile();

  return {
    tools: toolsOut,
    disconnect,
    callTool: callGoogleWorkspaceTool,
    hasStoredCredentials,
  };
};
