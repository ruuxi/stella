/**
 * Tool metadata + JSON schemas exposed to the LLM.
 *
 * Stella now uses a hybrid surface:
 * - the General agent stays Exec-first (`Exec` / `Wait`)
 * - the Orchestrator keeps a small direct coordination surface
 * - `RequestCredential` / `AskUserQuestion` remain top-level UI round-trips
 *
 * Internal helpers (`Read`, `Grep`) are retained for Explore only and are not
 * meant for ordinary agent prompts.
 */

import {
  EXEC_JSON_SCHEMA,
  WAIT_JSON_SCHEMA,
  WAIT_TOOL_DESCRIPTION,
  buildExecToolDescription,
} from "../exec/exec-contract.js";

export const DEVICE_TOOL_NAMES = [
  "Exec",
  "Wait",
  "AskUserQuestion",
  "RequestCredential",
] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export const DANGEROUS_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i,
    reason: "rm -rf /",
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i,
    reason: "rm -rf /",
  },
  {
    pattern:
      /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i,
    reason: "rm -rf ~",
  },
  {
    pattern:
      /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i,
    reason: "rm -rf ~",
  },
  { pattern: /\bformat\s+[a-zA-Z]:\s*/i, reason: "format drive" },
  { pattern: /\bdd\s+if=/i, reason: "dd if= (raw disk write)" },
  { pattern: /\bmkfs\b/i, reason: "mkfs (format filesystem)" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, reason: "fork bomb" },
  { pattern: /\bshutdown\b/i, reason: "shutdown" },
  { pattern: /\breboot\b/i, reason: "reboot" },
];

export function getDangerousCommandReason(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

const AskUserQuestionJsonSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask (end with ?).",
          },
          header: {
            type: "string",
            description: "Short label displayed as a tag (max 12 chars).",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Option text (1-5 words).",
                },
                description: {
                  type: "string",
                  description:
                    "What this option means or what happens if chosen.",
                },
              },
              required: ["label", "description"],
            },
          },
          multiSelect: {
            type: "boolean",
            description: "Allow selecting multiple options.",
          },
        },
        required: ["question", "header", "options", "multiSelect"],
      },
    },
  },
  required: ["questions"],
};

const RequestCredentialJsonSchema = {
  type: "object",
  properties: {
    provider: {
      type: "string",
      description: 'Unique key for this secret (e.g. "github_token").',
    },
    label: {
      type: "string",
      description: 'Display name shown to the user (e.g. "GitHub Token").',
    },
    description: {
      type: "string",
      description: "Why this credential is needed.",
    },
    placeholder: { type: "string", description: "Input placeholder text." },
  },
  required: ["provider"],
};

const ScheduleJsonSchema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "Plain-language scheduling request for local cron jobs and heartbeats.",
    },
  },
  required: ["prompt"],
};

const WebSearchJsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language search query. Write descriptively, not as keywords.",
    },
    category: {
      type: "string",
      enum: ["company", "people", "research paper"],
      description:
        "Optional category filter. Omit for news, sports, and general facts.",
    },
  },
  required: ["query"],
};

const WebFetchJsonSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "URL to fetch. HTTP URLs are upgraded to HTTPS when possible.",
    },
    prompt: {
      type: "string",
      description: "Optional context describing what information to extract.",
    },
  },
  required: ["url"],
};

const DisplayJsonSchema = {
  type: "object",
  properties: {
    i_have_read_guidelines: {
      type: "boolean",
      description:
        "Confirm you already called DisplayGuidelines in this conversation.",
    },
    html: {
      type: "string",
      description:
        "HTML or SVG fragment to render. SVG should start with <svg>; HTML should be a fragment, not a full document.",
    },
  },
  required: ["i_have_read_guidelines", "html"],
};

const DisplayGuidelinesJsonSchema = {
  type: "object",
  properties: {
    modules: {
      type: "array",
      items: {
        type: "string",
        enum: ["interactive", "chart", "mockup", "art", "diagram", "text"],
      },
      description: "Which guideline module(s) to load.",
    },
  },
  required: ["modules"],
};

const TaskCreateJsonSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "Short summary shown in the task list.",
    },
    prompt: {
      type: "string",
      description:
        "Detailed instructions for the General agent. This is the agent's only context.",
    },
  },
  required: ["description", "prompt"],
};

const TaskOutputJsonSchema = {
  type: "object",
  properties: {
    thread_id: {
      type: "string",
      description: "Durable thread id returned by TaskCreate.",
    },
  },
  required: ["thread_id"],
};

const TaskPauseJsonSchema = {
  type: "object",
  properties: {
    thread_id: {
      type: "string",
      description: "Durable thread id to pause.",
    },
    reason: {
      type: "string",
      description: "Optional explanation for why the task is being paused.",
    },
  },
  required: ["thread_id"],
};

const TaskUpdateJsonSchema = {
  type: "object",
  properties: {
    thread_id: {
      type: "string",
      description: "Durable thread id to continue or revise.",
    },
    message: {
      type: "string",
      description: "Follow-up instruction to deliver to the task thread.",
    },
  },
  required: ["thread_id", "message"],
};

// Internal-only schemas (Explore subagent + memory-review reach these through
// `executeTool` / `dispatchLocalTool`).
const ReadJsonSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Absolute or repo-relative file path." },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  required: ["file_path"],
};

const GrepJsonSchema = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    glob: { type: "string" },
    type: { type: "string" },
    output_mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"],
    },
    case_insensitive: { type: "boolean" },
    context_lines: { type: "number" },
    max_results: { type: "number" },
  },
  required: ["pattern"],
};

const DreamJsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "markProcessed"],
      description:
        "list = fetch unprocessed thread_summaries + memories_extensions newer than the persisted Dream state. markProcessed = stamp rows + extension paths as consumed.",
    },
    sinceWatermark: {
      type: "number",
      description:
        "Optional Unix epoch ms override for thread_summaries returned by list.",
    },
    limit: {
      type: "number",
      description: "Optional cap on rows returned by list (default 50, max 500).",
    },
    threadKeys: {
      type: "array",
      description:
        "markProcessed: list of {threadId, runId} pairs to stamp as processed.",
      items: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          runId: { type: "string" },
        },
        required: ["threadId", "runId"],
      },
    },
    threadIds: {
      type: "array",
      description:
        "markProcessed: shortcut to mark every unprocessed run for these threadIds.",
      items: { type: "string" },
    },
    extensionPaths: {
      type: "array",
      description:
        "markProcessed: list of memories_extensions/* file paths the agent consumed.",
      items: { type: "string" },
    },
    watermark: {
      type: "number",
      description:
        "markProcessed: explicit watermark to persist. Defaults to now.",
    },
  },
  required: ["action"],
};

const StrReplaceJsonSchema = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      description: "Absolute file path to mutate. The file must already exist.",
    },
    old_string: {
      type: "string",
      description:
        "Exact text to replace. Must be unique within the file unless replace_all is true.",
    },
    new_string: {
      type: "string",
      description: "Replacement text. May be empty to delete.",
    },
    replace_all: {
      type: "boolean",
      description: "Replace every occurrence of old_string. Defaults to false.",
    },
  },
  required: ["file_path", "old_string", "new_string"],
};

const MemoryJsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["add", "replace", "remove"],
      description: "Mutation to apply to the chosen target.",
    },
    target: {
      type: "string",
      enum: ["memory", "user"],
      description:
        "Which store to mutate. 'user' = identity store. 'memory' = your own notes.",
    },
    content: {
      type: "string",
      description: "Required for action=add and action=replace. The new entry text.",
    },
    oldText: {
      type: "string",
      description:
        "Required for action=replace and action=remove. A short unique substring identifying the entry.",
    },
  },
  required: ["action", "target"],
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  Exec: buildExecToolDescription([]),
  Wait: WAIT_TOOL_DESCRIPTION,
  AskUserQuestion:
    "Ask the user to choose between options via a UI prompt. Use for clarifications, decisions, or preferences.",
  RequestCredential:
    "Request an API key or secret via a secure UI prompt. Returns a `secretId` handle that can be passed to other tools/integrations.",
  Schedule:
    "Handle local scheduling requests in plain language. Delegates to the schedule specialist and returns a short summary.",
  WebSearch:
    "Search the web for current information. Best for facts that change over time, recent news, and current documentation.",
  WebFetch:
    "Fetch a URL and return readable text content with HTML stripped.",
  Display:
    "Render HTML or SVG on the canvas panel. Call DisplayGuidelines before the first Display call.",
  DisplayGuidelines:
    "Return design guidelines for Display (layout, CSS, typography, examples). Call once before first use.",
  TaskCreate:
    "Create a background task executed by the General agent. Returns immediately with a durable `thread_id`; the task is NOT finished yet.",
  TaskOutput:
    "Check the current status and output of a task thread.",
  TaskPause:
    "Pause a running task thread. The same thread can be resumed later with TaskUpdate.",
  TaskUpdate:
    "Continue or revise an existing task thread by sending it a new message.",
  Memory:
    "Manage durable memory entries that survive across sessions (`target: \"user\"` or `target: \"memory\"`).",
  Dream:
    "Background memory consolidator IO. action=\"list\" returns unprocessed thread_summaries + pending memories_extensions paths; action=\"markProcessed\" advances the Dream watermark data.",
  StrReplace:
    "Surgically replace exact text inside an existing file. old_string must uniquely identify the target unless replace_all is true.",
  // Internal-only descriptors (Explore subagent uses Read/Grep).
  Read: "Read a file from the filesystem (internal).",
  Grep: "Search file contents using ripgrep (internal).",
};

export const TOOL_JSON_SCHEMAS: Record<string, object> = {
  Exec: EXEC_JSON_SCHEMA,
  Wait: WAIT_JSON_SCHEMA,
  AskUserQuestion: AskUserQuestionJsonSchema,
  RequestCredential: RequestCredentialJsonSchema,
  Schedule: ScheduleJsonSchema,
  WebSearch: WebSearchJsonSchema,
  WebFetch: WebFetchJsonSchema,
  Display: DisplayJsonSchema,
  DisplayGuidelines: DisplayGuidelinesJsonSchema,
  TaskCreate: TaskCreateJsonSchema,
  TaskOutput: TaskOutputJsonSchema,
  TaskPause: TaskPauseJsonSchema,
  TaskUpdate: TaskUpdateJsonSchema,
  Memory: MemoryJsonSchema,
  Dream: DreamJsonSchema,
  StrReplace: StrReplaceJsonSchema,
  Read: ReadJsonSchema,
  Grep: GrepJsonSchema,
};
