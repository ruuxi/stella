/**
 * Backend-local device tool schemas and descriptions for backend-driven flows.
 *
 * Codex-style code mode: only `Exec`, `Wait`, `AskUserQuestion`, and
 * `RequestCredential` are surfaced to the model. Everything else lives inside
 * `tools.*` via the device-side `ExecToolRegistry`.
 */

import { z } from "zod";

export const DEVICE_TOOL_NAMES = [
  "Exec",
  "Wait",
  "AskUserQuestion",
  "RequestCredential",
] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i, reason: "rm -rf /" },
  { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i, reason: "rm -rf /" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i, reason: "rm -rf ~" },
  { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i, reason: "rm -rf ~" },
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

export const ExecSchema = z.object({
  summary: z
    .string()
    .describe("Short description of what the program will accomplish."),
  source: z
    .string()
    .describe(
      "Async TypeScript program body. Top-level await/return supported. Use `tools.<name>(...)` for capabilities and `text(...)` / `image(...)` for rich content.",
    ),
  timeoutMs: z
    .number()
    .optional()
    .describe("Optional execution timeout in milliseconds (default 30000, max 120000)."),
});

export const WaitSchema = z.object({
  cell_id: z
    .string()
    .describe("Cell id of a yielded `Exec` cell to resume."),
  yield_after_ms: z
    .number()
    .optional()
    .describe("How long to wait for new output before yielding again (default 10000)."),
  terminate: z
    .boolean()
    .optional()
    .describe("Force-terminate the cell instead of resuming."),
});

export const AskUserQuestionSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string().describe("The question to ask (end with ?)."),
      header: z.string().describe("Short label displayed as a tag (max 12 chars)."),
      options: z.array(
        z.object({
          label: z.string().describe("Option text (1-5 words)."),
          description: z.string().describe("What this option means or what happens if chosen."),
        }),
      ),
      multiSelect: z.boolean().describe("Allow selecting multiple options."),
    }),
  ),
});

export const RequestCredentialSchema = z.object({
  provider: z.string().min(1).describe("Unique key for this secret (e.g. \"github_token\")."),
  label: z.string().optional().describe("Display name shown to the user (e.g. \"GitHub Token\")."),
  description: z.string().optional().describe("Why this credential is needed."),
  placeholder: z.string().optional().describe("Input placeholder text."),
});

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  Exec:
    "Run an async TypeScript program in Stella's persistent V8 runtime. Capabilities are exposed as `tools.<name>(...)` entries; built-in globals (`text`, `image`, `store`, `load`, `notify`, `yield_control`, `exit`) stay tiny and stable. Use `apply_patch` for edits, `// @exec: yield_after_ms=...` to background long-running work.",
  Wait:
    "Resume a yielded `Exec` cell by `cell_id`. Used after a program backgrounded itself with `// @exec:` or called `yield_control()`.",
  AskUserQuestion:
    "Ask the user to choose between options via a UI prompt. Use for clarifications, decisions, or preferences.",
  RequestCredential:
    "Request an API key or secret via a secure UI prompt. Returns a `secretId` handle that other tools can pass through.",
};

export const TOOL_SCHEMAS = {
  Exec: ExecSchema,
  Wait: WaitSchema,
  AskUserQuestion: AskUserQuestionSchema,
  RequestCredential: RequestCredentialSchema,
} as const;
