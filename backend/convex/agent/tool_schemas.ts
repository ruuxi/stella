/**
 * Backend-local device tool schemas and descriptions.
 *
 * These define the model-facing contract for device tools still used by
 * backend-driven flows.
 */

import { z } from "zod";

// ─── Device Tool Names ──────────────────────────────────────────────────────

export const DEVICE_TOOL_NAMES = [
  "Read",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "KillShell",
  "ShellStatus",
  "AskUserQuestion",
  "RequestCredential",
  "SkillBash",
  "MediaGenerate",
] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

// ─── Dangerous Command Patterns ─────────────────────────────────────────────

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

// ─── Tool Schemas ───────────────────────────────────────────────────────────
// Canonical zod schemas for device tool parameters.
// Backend uses these directly in tool() definitions.
// Frontend wraps them with .passthrough() and alias extensions.

export const ReadSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to read"),
  offset: z.number().optional().describe("Line number to start reading from (1-based)"),
  limit: z.number().optional().describe("Max number of lines to read"),
});

export const EditSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to edit"),
  old_string: z.string().describe("Exact text to find and replace (must be unique unless replace_all=true)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace all occurrences instead of requiring uniqueness"),
});

export const GlobSchema = z.object({
  pattern: z.string().describe("Glob pattern to match (e.g. \"**/*.ts\", \"src/**/*.json\")"),
  path: z.string().optional().describe("Directory to search in (defaults to working directory)"),
});

export const GrepSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().describe("File or directory to search in"),
  glob: z.string().optional().describe("Filter files by glob pattern (e.g. \"*.tsx\")"),
  type: z.string().optional().describe("Filter by file type (e.g. \"ts\", \"py\", \"json\")"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("What to return: matching lines, file paths, or counts"),
  case_insensitive: z.boolean().optional().describe("Case-insensitive search"),
  context_lines: z.number().optional().describe("Lines of context around each match (for output_mode=content)"),
  max_results: z.number().optional().describe("Maximum number of results to return"),
});

export const BashSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  description: z.string().optional().describe("Human-readable description of what this command does"),
  timeout: z.number().optional().describe("Timeout in milliseconds (default 120000, max 600000)"),
  working_directory: z.string().optional().describe("Working directory for the command"),
  run_in_background: z.boolean().optional().describe("Run in background and return a shell_id immediately"),
});

export const KillShellSchema = z.object({
  shell_id: z.string().describe("Shell ID returned by Bash with run_in_background=true"),
});

export const ShellStatusSchema = z.object({
  shell_id: z.string().optional().describe("Shell ID to check. Omit to list all shells."),
  tail_lines: z.number().optional().describe("Number of output lines to return from the end (default 50)"),
});

export const AskUserQuestionSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string().describe("The question to ask (end with ?)"),
      header: z.string().describe("Short label displayed as a tag (max 12 chars)"),
      options: z.array(
        z.object({
          label: z.string().describe("Option text (1-5 words)"),
          description: z.string().describe("What this option means or what happens if chosen"),
        }),
      ),
      multiSelect: z.boolean().describe("Allow selecting multiple options"),
    }),
  ),
});

export const RequestCredentialSchema = z.object({
  provider: z.string().min(1).describe("Unique key for this secret (e.g. \"github_token\")"),
  label: z.string().optional().describe("Display name shown to the user (e.g. \"GitHub Token\")"),
  description: z.string().optional().describe("Why this credential is needed"),
  placeholder: z.string().optional().describe("Input placeholder text"),
});

export const SkillBashSchema = z.object({
  skill_id: z.string().min(1).describe("ID of the skill whose secrets to mount"),
  command: z.string().min(1).describe("Shell command to execute"),
  description: z.string().optional().describe("Human-readable description of what this command does"),
  timeout: z.number().optional().describe("Timeout in milliseconds (default 120000, max 600000)"),
  working_directory: z.string().optional().describe("Working directory for the command"),
  run_in_background: z.boolean().optional().describe("Run in background and return a shell_id"),
});

export const MediaGenerateSchema = z.object({
  mode: z.enum(["generate", "edit"]).default("generate").describe("Create new or edit existing"),
  media_type: z.enum(["image", "video"]).default("image").describe("Type of media to produce"),
  prompt: z.string().describe("Description of what to generate or how to edit"),
  source_url: z.string().optional().describe("URL of source media to edit (required for mode=edit)"),
});

// ─── Tool Descriptions ──────────────────────────────────────────────────────

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  Read:
    "Read a file from the local filesystem.\n\n" +
    "Usage:\n" +
    "- file_path must be an absolute path.\n" +
    "- By default reads up to 2000 lines from the start. Use offset and limit for large files.\n" +
    "- Returns content with line numbers (cat -n format).\n" +
    "- Always read a file before editing or overwriting it.\n" +
    "- Can read images (PNG, JPG, etc.) — contents are returned as visual data.",
  Edit:
    "Make exact string replacements in a file.\n\n" +
    "Usage:\n" +
    "- Review the file content first (e.g. `cat` or `head` via Bash). This tool will fail if you haven't seen the file.\n" +
    "- old_string must match the file content exactly, including whitespace and indentation.\n" +
    "- The edit will FAIL if old_string appears more than once in the file. Provide more surrounding context to make it unique, or use replace_all=true to change every occurrence.\n" +
    "- Prefer this over Write for modifying existing files.",
  Glob:
    "Find files by glob pattern.\n\n" +
    "Usage:\n" +
    "- Supports patterns like \"**/*.ts\", \"src/**/*.tsx\", \"*.json\".\n" +
    "- Returns matching file paths sorted by modification time (newest first).\n" +
    "- Use path to limit the search to a specific directory.\n" +
    "- Use this instead of Bash with find or ls.",
  Grep:
    "Search file contents using ripgrep regex.\n\n" +
    "Usage:\n" +
    "- pattern is a regular expression (e.g. \"function\\s+\\w+\", \"TODO|FIXME\").\n" +
    "- output_mode controls what's returned:\n" +
    "  - \"files_with_matches\" (default): just file paths that match.\n" +
    "  - \"content\": matching lines with context.\n" +
    "  - \"count\": number of matches per file.\n" +
    "- Use glob to filter by file pattern (e.g. \"*.ts\") or type for standard file types (e.g. \"js\", \"py\").\n" +
    "- Use this instead of Bash with grep or rg.",
  Bash:
    "Execute a shell command on the local device.\n\n" +
    "Usage:\n" +
    "- Use Bash for reading files (`cat`, `head -n`, `tail -n`, `sed -n '10,20p'`), creating/writing files (heredoc, `tee`, echo redirection), and all other shell operations.\n" +
    "- For targeted edits to existing files, prefer the Edit tool over sed/awk.\n" +
    "- Default timeout is 120 seconds, max 600 seconds.\n" +
    "- When run_in_background=true, returns immediately with a shell_id. Use KillShell to stop it later.\n" +
    "- Use description to explain non-obvious commands (helps with logging and debugging).\n" +
    "- On Windows, commands run in Git Bash for consistent bash syntax.",
  KillShell:
    "Stop a background shell process.\n\n" +
    "Usage:\n" +
    "- Use the shell_id returned by Bash when run_in_background=true.\n" +
    "- Returns the accumulated output from the killed process.",
  ShellStatus:
    "Check the status and output of a background shell process without killing it.\n\n" +
    "Usage:\n" +
    "- If shell_id is provided, returns status, elapsed time, and tail of output.\n" +
    "- If shell_id is omitted, lists all active/completed shells.\n" +
    "- Use tail_lines to control how many lines of output to retrieve (default 50).\n" +
    "- Use this to monitor long-running commands before deciding to KillShell.",
  AskUserQuestion:
    "Ask the user to choose between options via a UI prompt.\n\n" +
    "Usage:\n" +
    "- Present 1-4 questions, each with 2-4 options.\n" +
    "- The user can always select \"Other\" to provide free-form text input.\n" +
    "- Use multiSelect=true when choices aren't mutually exclusive.\n" +
    "- Use when you need user decisions on implementation choices, preferences, or clarifications.",
  RequestCredential:
    "Request an API key or secret from the user via a secure UI prompt.\n\n" +
    "Usage:\n" +
    "- Displays a secure input dialog where the user enters a credential.\n" +
    "- Returns a secretId handle (not the raw value) for use with IntegrationRequest or SkillBash.\n" +
    "- The secret is stored encrypted in the user's vault.\n" +
    "- Use provider as a unique key (e.g. \"openweather_api_key\"). Same provider reuses existing secret.",
  SkillBash:
    "Execute a shell command with a skill's secrets automatically mounted as environment variables or files.\n\n" +
    "Usage:\n" +
    "- Like Bash, but injects secrets defined in the skill's secretMounts config.\n" +
    "- skill_id must match a skill that has secretMounts configured.\n" +
    "- If the required secret doesn't exist, the user will be prompted via RequestCredential automatically.\n" +
    "- Use this instead of Bash when running commands that need API keys or tokens from a skill.",
  MediaGenerate:
    "Generate or edit images and video.\n\n" +
    "Usage:\n" +
    "- mode=\"generate\": Create new media from a text prompt.\n" +
    "- mode=\"edit\": Modify an existing image/video (provide source_url).\n" +
    "- prompt describes what to generate or how to edit.\n" +
    "- media_type: \"image\" or \"video\".",
};

// ─── Schema Map ─────────────────────────────────────────────────────────────

export const TOOL_SCHEMAS = {
  Read: ReadSchema,
  Edit: EditSchema,
  Glob: GlobSchema,
  Grep: GrepSchema,
  Bash: BashSchema,
  KillShell: KillShellSchema,
  ShellStatus: ShellStatusSchema,
  AskUserQuestion: AskUserQuestionSchema,
  RequestCredential: RequestCredentialSchema,
  SkillBash: SkillBashSchema,
  MediaGenerate: MediaGenerateSchema,
} as const;

