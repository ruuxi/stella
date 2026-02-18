/**
 * Local tool assembly — creates AI SDK tool definitions that execute in-process.
 * Tools run synchronously via the existing tool host, eliminating the poll-based round-trip.
 */

import { tool } from "ai";
import { z } from "zod";
import { insert, update, rawQuery, newId } from "../db";
import { broadcastSSE } from "../server";
import {
  createTask,
  updateTaskStatus,
  addTaskStatusUpdate,
  cancelTask,
  getTaskById,
} from "./tasks_local";

const log = (...args: unknown[]) => console.log("[local-tools]", ...args);

type ToolHost = {
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    context: { conversationId: string; deviceId: string; requestId: string; agentType?: string },
  ) => Promise<{ result?: unknown; error?: string }>;
};

type ToolAssemblyOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  ownerId: string;
  conversationId: string;
  deviceId: string;
  toolHost: ToolHost;
};

/**
 * Build AI SDK tool definitions for the local agent runtime.
 * Device tools execute in-process via the tool host.
 * Orchestration tools (TaskCreate, etc.) use local SQLite.
 */
export function createLocalTools(options: ToolAssemblyOptions): Record<string, ReturnType<typeof tool>> {
  const {
    agentType,
    toolsAllowlist,
    maxTaskDepth,
    ownerId,
    conversationId,
    deviceId,
    toolHost,
  } = options;

  const tools: Record<string, ReturnType<typeof tool>> = {};

  // ─── Device Tools (execute via tool host) ──────────────────────────────

  const deviceToolNames = [
    "Read", "Write", "Edit", "Glob", "Grep", "Bash", "KillShell", "ShellStatus",
    "WebFetch", "WebSearch", "OpenApp", "ListResources",
    "SkillBash", "RequestCredential", "IntegrationRequest",
    "MediaGenerate",
  ];

  for (const toolName of deviceToolNames) {
    if (toolsAllowlist && !toolsAllowlist.includes(toolName)) continue;

    tools[toolName] = tool({
      description: `Execute the ${toolName} tool locally`,
      parameters: z.record(z.unknown()),
      execute: async (args) => {
        const requestId = newId();
        log(`Executing device tool: ${toolName}`, { requestId });

        // Record tool_request event
        insert("events", {
          conversation_id: conversationId,
          timestamp: Date.now(),
          type: "tool_request",
          payload: JSON.stringify({ toolName, args, agentType }),
          device_id: deviceId,
          request_id: requestId,
          target_device_id: deviceId,
        });

        broadcastSSE(conversationId, "event_added", {
          type: "tool_request",
          payload: { toolName, args },
        });

        // Execute in-process
        const result = await toolHost.executeTool(toolName, args as Record<string, unknown>, {
          conversationId,
          deviceId,
          requestId,
          agentType,
        });

        // Record tool_result event
        insert("events", {
          conversation_id: conversationId,
          timestamp: Date.now(),
          type: "tool_result",
          payload: JSON.stringify({
            toolName,
            result: result.result,
            error: result.error,
            requestId,
          }),
          device_id: deviceId,
          request_id: requestId,
        });

        broadcastSSE(conversationId, "event_added", {
          type: "tool_result",
          payload: { toolName, result: result.result, error: result.error },
        });

        if (result.error) {
          return `Error: ${result.error}`;
        }
        return typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result);
      },
    });
  }

  // ─── Backend Tools (execute locally) ───────────────────────────────────

  if (!toolsAllowlist || toolsAllowlist.includes("AskUserQuestion")) {
    tools["AskUserQuestion"] = tool({
      description: "Ask the user a question and wait for their response",
      parameters: z.object({
        question: z.string().describe("The question to ask"),
        suggestions: z.array(z.string()).optional().describe("Suggested answers"),
      }),
      execute: async ({ question, suggestions }) => {
        const requestId = newId();
        insert("events", {
          conversation_id: conversationId,
          timestamp: Date.now(),
          type: "ask_user",
          payload: JSON.stringify({ question, suggestions }),
          request_id: requestId,
        });
        broadcastSSE(conversationId, "event_added", {
          type: "ask_user",
          payload: { question, suggestions, requestId },
        });
        return `Question sent to user: ${question}`;
      },
    });
  }

  if (!toolsAllowlist || toolsAllowlist.includes("OpenCanvas")) {
    tools["OpenCanvas"] = tool({
      description: "Open a canvas panel",
      parameters: z.object({
        name: z.string(),
        title: z.string().optional(),
        url: z.string().optional(),
      }),
      execute: async ({ name, title, url }) => {
        insert("events", {
          conversation_id: conversationId,
          timestamp: Date.now(),
          type: "canvas_command",
          payload: JSON.stringify({ action: "open", name, title, url }),
        });
        broadcastSSE(conversationId, "event_added", {
          type: "canvas_command",
          payload: { action: "open", name, title, url },
        });

        // Update canvas state
        const now = Date.now();
        const existing = rawQuery(
          "SELECT id FROM canvas_states WHERE owner_id = ? AND conversation_id = ?",
          [ownerId, conversationId],
        );
        if (existing.length > 0) {
          update("canvas_states", { name, title: title || null, url: url || null, updated_at: now },
            { id: (existing[0] as { id: string }).id });
        } else {
          insert("canvas_states", {
            owner_id: ownerId,
            conversation_id: conversationId,
            name, title: title || null, url: url || null, updated_at: now,
          });
        }

        return `Canvas "${name}" opened`;
      },
    });
  }

  if (!toolsAllowlist || toolsAllowlist.includes("CloseCanvas")) {
    tools["CloseCanvas"] = tool({
      description: "Close the canvas panel",
      parameters: z.object({}),
      execute: async () => {
        insert("events", {
          conversation_id: conversationId,
          timestamp: Date.now(),
          type: "canvas_command",
          payload: JSON.stringify({ action: "close" }),
        });
        broadcastSSE(conversationId, "event_added", {
          type: "canvas_command",
          payload: { action: "close" },
        });
        return "Canvas closed";
      },
    });
  }

  if (!toolsAllowlist || toolsAllowlist.includes("SaveMemory")) {
    tools["SaveMemory"] = tool({
      description: "Save a fact or memory for future recall",
      parameters: z.object({
        content: z.string().describe("The content to remember"),
      }),
      execute: async ({ content }) => {
        // Memory saving is handled by the memory module
        // For now, just insert directly
        insert("memories", {
          owner_id: ownerId,
          content,
          accessed_at: Date.now(),
          created_at: Date.now(),
        });
        return `Memory saved: "${content.slice(0, 100)}..."`;
      },
    });
  }

  if (!toolsAllowlist || toolsAllowlist.includes("RecallMemories")) {
    tools["RecallMemories"] = tool({
      description: "Search memories for relevant information",
      parameters: z.object({
        query: z.string().describe("Search query"),
      }),
      execute: async ({ query }) => {
        // Text-based fallback (no embedding in sync context)
        const memories = rawQuery<{ content: string; accessed_at: number }>(
          "SELECT content, accessed_at FROM memories WHERE owner_id = ? ORDER BY accessed_at DESC LIMIT 10",
          [ownerId],
        );
        if (memories.length === 0) return "No memories found.";
        return memories.map((m) => m.content).join("\n---\n");
      },
    });
  }

  if (!toolsAllowlist || toolsAllowlist.includes("NoResponse")) {
    tools["NoResponse"] = tool({
      description: "Indicate that no response to the user is needed",
      parameters: z.object({
        reason: z.string().optional(),
      }),
      execute: async ({ reason }) => {
        return `No response needed${reason ? `: ${reason}` : ""}`;
      },
    });
  }

  // ─── Orchestration Tools ───────────────────────────────────────────────

  if (maxTaskDepth > 0 && (!toolsAllowlist || toolsAllowlist.includes("TaskCreate"))) {
    tools["TaskCreate"] = tool({
      description: "Create a background task to be executed by a subagent",
      parameters: z.object({
        description: z.string(),
        prompt: z.string(),
        agentType: z.string().default("general"),
      }),
      execute: async ({ description, prompt, agentType: taskAgentType }) => {
        const taskId = createTask({
          conversationId,
          description,
          prompt,
          agentType: taskAgentType,
          taskDepth: 1,
        });
        return `Task created: ${taskId} (${description})`;
      },
    });
  }

  if (maxTaskDepth > 0 && (!toolsAllowlist || toolsAllowlist.includes("TaskOutput"))) {
    tools["TaskOutput"] = tool({
      description: "Check the status and output of a previously created task",
      parameters: z.object({
        taskId: z.string(),
      }),
      execute: async ({ taskId }) => {
        const task = getTaskById(taskId);
        if (!task) return `Task ${taskId} not found`;
        const lines = [`Status: ${task.status}`];
        if (task.result) lines.push(`Result: ${task.result}`);
        if (task.error) lines.push(`Error: ${task.error}`);
        return lines.join("\n");
      },
    });
  }

  if (!toolsAllowlist || toolsAllowlist.includes("TaskCancel")) {
    tools["TaskCancel"] = tool({
      description: "Cancel a running task",
      parameters: z.object({
        taskId: z.string(),
      }),
      execute: async ({ taskId }) => {
        cancelTask(taskId);
        return `Task ${taskId} cancelled`;
      },
    });
  }

  if (!toolsAllowlist || toolsAllowlist.includes("ActivateSkill")) {
    tools["ActivateSkill"] = tool({
      description: "Load a skill's full instructions",
      parameters: z.object({
        skillId: z.string(),
      }),
      execute: async ({ skillId }) => {
        const rows = rawQuery<{ markdown: string; name: string }>(
          "SELECT markdown, name FROM skills WHERE skill_id = ? AND enabled = 1 LIMIT 1",
          [skillId],
        );
        if (rows.length === 0) return `Skill "${skillId}" not found or not enabled`;
        return `# Skill: ${rows[0].name}\n\n${rows[0].markdown}`;
      },
    });
  }

  // ─── Store Tools ───────────────────────────────────────────────────────

  if (!toolsAllowlist || toolsAllowlist.includes("StoreSearch")) {
    tools["StoreSearch"] = tool({
      description: "Search the package store",
      parameters: z.object({
        query: z.string(),
        type: z.string().optional(),
      }),
      execute: async ({ query, type }) => {
        let sql = "SELECT package_id, name, description, type FROM store_packages WHERE search_text LIKE ?";
        const params: unknown[] = [`%${query}%`];
        if (type) {
          sql += " AND type = ?";
          params.push(type);
        }
        sql += " LIMIT 10";
        const rows = rawQuery(sql, params);
        return JSON.stringify(rows);
      },
    });
  }

  // Filter by allowlist
  if (toolsAllowlist) {
    for (const key of Object.keys(tools)) {
      if (!toolsAllowlist.includes(key)) {
        delete tools[key];
      }
    }
  }

  return tools;
}
