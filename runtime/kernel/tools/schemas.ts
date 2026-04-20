/**
 * Tool metadata + JSON schemas exposed to the LLM.
 *
 * Codex-style code mode: the only general-purpose surface is `Exec` + `Wait`.
 * `RequestCredential` and `AskUserQuestion` stay top-level because they need
 * to round-trip through the chat UI (not the V8 runtime). Everything else
 * lives inside `tools.*` via the `ExecToolRegistry`.
 *
 * The Explore subagent additionally calls `Read` / `Grep` through
 * `toolHost.executeTool`, so we keep those two internal-only descriptors
 * (and matching handler entries in `registry.ts`) so the existing Explore
 * loop continues to work.
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
  // Internal-only descriptors (Explore subagent uses Read/Grep; memory-review
  // uses Memory). These are not part of the model-facing tool catalog for
  // top-level agents.
  Read: "Read a file from the filesystem (internal).",
  Grep: "Search file contents using ripgrep (internal).",
  Memory:
    "Manage durable memory entries (internal — used by the memory-review pass).",
};

export const TOOL_JSON_SCHEMAS: Record<string, object> = {
  Exec: EXEC_JSON_SCHEMA,
  Wait: WAIT_JSON_SCHEMA,
  AskUserQuestion: AskUserQuestionJsonSchema,
  RequestCredential: RequestCredentialJsonSchema,
  Read: ReadJsonSchema,
  Grep: GrepJsonSchema,
  Memory: MemoryJsonSchema,
};
