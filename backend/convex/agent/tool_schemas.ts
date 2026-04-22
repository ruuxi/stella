/**
 * Backend-local device tool schemas and descriptions for backend-driven flows.
 *
 * Stella's default General agent surface is now codex-style instead of
 * `Exec` / `Wait`.
 */

import { z } from "zod";

export const DEVICE_TOOL_NAMES = [
  "exec_command",
  "write_stdin",
  "apply_patch",
  "web",
  "RequestCredential",
  "multi_tool_use.parallel",
  "view_image",
  "image_gen",
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

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ExecCommandSchema = z.object({
  cmd: z.string().describe("Shell command to execute."),
  workdir: z
    .string()
    .optional()
    .describe("Optional working directory. Defaults to the turn cwd."),
  yield_time_ms: z.number().optional(),
  max_output_tokens: z.number().optional(),
});

export const WriteStdinSchema = z.object({
  session_id: z
    .union([z.string(), z.number()])
    .describe("Session id returned by a previous exec_command call."),
  chars: z
    .string()
    .optional()
    .describe("Characters to write to stdin. May be empty to poll."),
  yield_time_ms: z.number().optional(),
  max_output_tokens: z.number().optional(),
});

export const ApplyPatchSchema = z.object({
  patch: z
    .string()
    .describe("Patch envelope starting with `*** Begin Patch` and ending with `*** End Patch`."),
});

export const WebSchema = z.object({
  query: z.string().optional().describe("Natural-language web search query."),
  url: z.string().optional().describe("Specific URL to fetch."),
  prompt: z
    .string()
    .optional()
    .describe("Optional extraction prompt for a direct URL fetch."),
  category: z
    .enum(["company", "people", "research paper"])
    .optional()
    .describe("Optional search category for query mode."),
});

export const MultiToolUseParallelSchema = z.object({
  tool_uses: z.array(
    z.object({
      recipient_name: z
        .string()
        .describe("Nested tool name, like `exec_command` or `functions.exec_command`."),
      parameters: JsonObjectSchema.describe("Arguments for the nested tool call."),
    }),
  ),
});

export const ViewImageSchema = z.object({
  path: z.string().describe("Absolute or repo-relative path to a local image file."),
  detail: z.literal("original").optional(),
});

export const ImageGenSchema = z.object({
  prompt: z.string().describe("Natural-language image prompt."),
  aspect_ratio: z.string().optional(),
  profile: z.enum(["best", "fast"]).optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  num_images: z.number().optional(),
  timeout_ms: z.number().optional(),
});

export const ReadSchema = z.object({
  file_path: z.string().describe("Absolute or repo-relative file path."),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

export const WriteSchema = z.object({
  file_path: z.string().describe("Absolute or repo-relative file path."),
  content: z.string().describe("Full file contents to write."),
});

export const EditSchema = z.object({
  file_path: z.string().describe("Absolute or repo-relative file path."),
  old_string: z
    .string()
    .describe("Exact text to replace. Must be unique unless replace_all is true."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional(),
});

export const BashSchema = z.object({
  command: z.string().describe("Shell command to execute."),
  working_directory: z.string().optional(),
  timeout: z.number().optional(),
  run_in_background: z.boolean().optional(),
});

export const GrepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  case_insensitive: z.boolean().optional(),
  context_lines: z.number().optional(),
  max_results: z.number().optional(),
});

export const ShellStatusSchema = z.object({
  shell_id: z.string().optional(),
  tail_lines: z.number().optional(),
});

export const KillShellSchema = z.object({
  shell_id: z.string().describe("Shell id returned by a previous Bash call."),
});

export const WebSearchSchema = z.object({
  query: z.string().describe("Natural-language web search query."),
  category: z
    .enum(["company", "people", "research paper"])
    .optional(),
});

export const WebFetchSchema = z.object({
  url: z.string().describe("URL to fetch."),
  prompt: z.string().optional(),
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
  exec_command:
    "Run a shell command and return output plus a live session_id when the process is still running.",
  write_stdin:
    "Write characters to a live exec_command session and return fresh output. Pass empty chars to poll.",
  apply_patch:
    "Apply a Codex-style patch envelope (`*** Begin Patch` ... `*** End Patch`) to one or more files.",
  web:
    "Unified web tool. Search the web with `query`, or fetch a specific page with `url`.",
  "multi_tool_use.parallel":
    "Execute multiple independent tool calls concurrently. Use only when the calls do not depend on each other.",
  view_image:
    "Attach a local image file from disk so the model can inspect it visually.",
  image_gen:
    "Generate one or more images through Stella's managed media backend and attach the finished files.",
  Read:
    "Read a file from the filesystem. Supports optional offset/limit for large files.",
  Write:
    "Write a full file to disk. Prefer Edit for surgical changes to existing files.",
  Edit:
    "Replace exact text inside an existing file.",
  Bash:
    "Run a shell command on the user's machine. Supports background jobs.",
  Grep:
    "Search file contents using ripgrep-style arguments.",
  ShellStatus:
    "Inspect a background Bash process.",
  KillShell:
    "Terminate a background Bash process.",
  WebSearch:
    "Search the web for current information.",
  WebFetch:
    "Fetch a URL and return readable text content.",
  AskUserQuestion:
    "Ask the user to choose between options via a UI prompt. Use for clarifications, decisions, or preferences.",
  RequestCredential:
    "Request an API key or secret via a secure UI prompt. Returns a `secretId` handle that other tools can pass through.",
};

export const TOOL_SCHEMAS = {
  exec_command: ExecCommandSchema,
  write_stdin: WriteStdinSchema,
  apply_patch: ApplyPatchSchema,
  web: WebSchema,
  RequestCredential: RequestCredentialSchema,
  "multi_tool_use.parallel": MultiToolUseParallelSchema,
  view_image: ViewImageSchema,
  image_gen: ImageGenSchema,
  Read: ReadSchema,
  Write: WriteSchema,
  Edit: EditSchema,
  Bash: BashSchema,
  Grep: GrepSchema,
  ShellStatus: ShellStatusSchema,
  KillShell: KillShellSchema,
  WebSearch: WebSearchSchema,
  WebFetch: WebFetchSchema,
  AskUserQuestion: AskUserQuestionSchema,
} as const;
