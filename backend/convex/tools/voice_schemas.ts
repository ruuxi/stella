/**
 * JSON Schema tool definitions for the OpenAI Realtime API.
 *
 * These mirror the orchestrator's tool allowlist from agents.ts but are
 * expressed as plain JSON Schema objects (not Zod) since the Realtime API
 * session config requires that format.
 */

export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function getVoiceToolSchemas(): VoiceToolSchema[] {
  return [
    // --- Direct execution tools ---
    {
      type: "function",
      name: "Read",
      description:
        "Read a file from the user's filesystem. Say a brief acknowledgment before calling.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to read",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-based)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read",
          },
        },
        required: ["file_path"],
      },
    },
    {
      type: "function",
      name: "Write",
      description:
        "Write content to a file, creating or overwriting it. Say a brief acknowledgment before calling.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to write",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["file_path", "content"],
      },
    },
    {
      type: "function",
      name: "Edit",
      description:
        "Replace a specific string in a file with new content. Say a brief acknowledgment before calling.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to edit",
          },
          old_string: {
            type: "string",
            description: "The exact text to find and replace",
          },
          new_string: {
            type: "string",
            description: "The replacement text",
          },
          replace_all: {
            type: "boolean",
            description: "Replace all occurrences (default false)",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    {
      type: "function",
      name: "Bash",
      description:
        "Execute a shell command on the user's computer. Say a brief acknowledgment before calling.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default 120000)",
          },
        },
        required: ["command"],
      },
    },

    // --- Orchestration / delegation tools ---
    {
      type: "function",
      name: "TaskCreate",
      description:
        "Delegate a task to a subagent. The task runs in the background. " +
        "Say something like 'Let me look into that' before calling.\n\n" +
        "subagent_type: 'general' (files, shell, coding), 'explore' (search, read-only), 'browser' (web automation).\n" +
        "Threads (general only): use thread_name for multi-step work.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Short summary for logging",
          },
          prompt: {
            type: "string",
            description:
              "Full instructions for the subagent. Be specific — the subagent only sees this prompt.",
          },
          subagent_type: {
            type: "string",
            enum: ["general", "explore", "browser"],
            description: "Which agent type to use",
          },
          thread_id: {
            type: "string",
            description: "Continue an existing thread by ID",
          },
          thread_name: {
            type: "string",
            description:
              "Create or reuse a named thread (short, kebab-case)",
          },
        },
        required: ["description", "prompt", "subagent_type"],
      },
    },
    {
      type: "function",
      name: "TaskOutput",
      description:
        "Check the result of a background subagent task. Returns completed result, running status, or error.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID returned by TaskCreate",
          },
        },
        required: ["task_id"],
      },
    },
    {
      type: "function",
      name: "TaskCancel",
      description: "Cancel a running subagent task.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to cancel",
          },
          reason: {
            type: "string",
            description: "Why the task is being canceled",
          },
        },
        required: ["task_id"],
      },
    },

    // --- Memory tools ---
    {
      type: "function",
      name: "RecallMemories",
      description:
        "Look up relevant memories from past conversations. Use when the user references something from before or you need prior context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language query describing what you need",
          },
          source: {
            type: "string",
            enum: ["memory", "history"],
            description: "Recall source (default: memory)",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "SaveMemory",
      description:
        "Save something worth remembering across conversations — preferences, decisions, personal details.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The information to remember (1-3 coherent sentences)",
          },
        },
        required: ["content"],
      },
    },

    // --- Canvas tools ---
    {
      type: "function",
      name: "OpenCanvas",
      description:
        "Display content in the canvas side panel. Delegate content creation to a General agent first, then call this.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Name of the panel or app to display",
          },
          title: {
            type: "string",
            description: "Panel header title (defaults to name)",
          },
          url: {
            type: "string",
            description:
              "Dev server URL for workspace apps (localhost only)",
          },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "CloseCanvas",
      description: "Close the canvas side panel.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },

    // --- Scheduling tools ---
    {
      type: "function",
      name: "HeartbeatGet",
      description:
        "Get the current heartbeat configuration for periodic monitoring.",
      parameters: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description: "Conversation ID (defaults to current)",
          },
        },
        required: [],
      },
    },
    {
      type: "function",
      name: "HeartbeatUpsert",
      description:
        "Create or update the heartbeat configuration for periodic monitoring. " +
        "intervalMs: how often to poll (min 60000ms). checklist: markdown instructions for each poll.",
      parameters: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          enabled: { type: "boolean" },
          intervalMs: { type: "number" },
          prompt: { type: "string" },
          checklist: { type: "string" },
          ackMaxChars: { type: "number" },
          deliver: { type: "boolean" },
          agentType: { type: "string" },
          activeHours: {
            type: "object",
            properties: {
              start: { type: "string" },
              end: { type: "string" },
              timezone: { type: "string" },
            },
            required: ["start", "end"],
          },
          targetDeviceId: { type: "string" },
        },
        required: [],
      },
    },
    {
      type: "function",
      name: "HeartbeatRun",
      description:
        "Trigger an immediate heartbeat run without waiting for the next interval.",
      parameters: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: [],
      },
    },
    {
      type: "function",
      name: "CronList",
      description: "List all cron jobs for the current user.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      type: "function",
      name: "CronAdd",
      description:
        "Create a new scheduled cron job. " +
        "Schedule types: { kind: 'at', atMs } for one-shot, { kind: 'every', everyMs } for interval, { kind: 'cron', expr, tz? } for cron expressions. " +
        "Payload types: { kind: 'systemEvent', text } for lightweight events, { kind: 'agentTurn', message } for full agent execution.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          schedule: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["at", "every", "cron"],
              },
              atMs: { type: "number" },
              everyMs: { type: "number" },
              anchorMs: { type: "number" },
              expr: { type: "string" },
              tz: { type: "string" },
            },
            required: ["kind"],
          },
          payload: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["systemEvent", "agentTurn"],
              },
              text: { type: "string" },
              message: { type: "string" },
              agentType: { type: "string" },
              deliver: { type: "boolean" },
            },
            required: ["kind"],
          },
          sessionTarget: { type: "string" },
          conversationId: { type: "string" },
          description: { type: "string" },
          enabled: { type: "boolean" },
          deleteAfterRun: { type: "boolean" },
        },
        required: ["name", "schedule", "payload", "sessionTarget"],
      },
    },
    {
      type: "function",
      name: "CronUpdate",
      description:
        "Update an existing cron job. Only include fields you want to change.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          patch: {
            type: "object",
            properties: {
              name: { type: "string" },
              schedule: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["at", "every", "cron"] },
                  atMs: { type: "number" },
                  everyMs: { type: "number" },
                  anchorMs: { type: "number" },
                  expr: { type: "string" },
                  tz: { type: "string" },
                },
                required: ["kind"],
              },
              payload: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["systemEvent", "agentTurn"] },
                  text: { type: "string" },
                  message: { type: "string" },
                  agentType: { type: "string" },
                  deliver: { type: "boolean" },
                },
                required: ["kind"],
              },
              sessionTarget: { type: "string" },
              conversationId: { type: "string" },
              description: { type: "string" },
              enabled: { type: "boolean" },
              deleteAfterRun: { type: "boolean" },
            },
          },
        },
        required: ["jobId", "patch"],
      },
    },
    {
      type: "function",
      name: "CronRemove",
      description: "Permanently delete a cron job.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string" },
        },
        required: ["jobId"],
      },
    },
    {
      type: "function",
      name: "CronRun",
      description:
        "Trigger an immediate run of a cron job, ignoring its schedule.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string" },
        },
        required: ["jobId"],
      },
    },

    // --- Remote machine ---
    {
      type: "function",
      name: "SpawnRemoteMachine",
      description:
        "Provision a remote cloud machine for the user.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },

    // --- Control ---
    {
      type: "function",
      name: "NoResponse",
      description:
        "Signal that you have nothing to say right now. Use for system events or task results that don't need a user-facing response.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ];
}
