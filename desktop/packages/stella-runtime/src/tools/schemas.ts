/**
 * Frontend-local tool metadata and schemas for the PI runtime.
 *
 * The PI runtime currently consumes the tool names, descriptions, and safety
 * helpers from this module.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

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
  "Display",
  "HeartbeatGet",
  "HeartbeatUpsert",
  "HeartbeatRun",
  "CronList",
  "CronAdd",
  "CronUpdate",
  "CronRemove",
  "CronRun",
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

export const WebSearchSchema = z.object({
  query: z.string().min(2).describe("Search query (natural language)"),
});

export const DisplaySchema = z.object({
  html: z.string().describe(
    "HTML content to render on the canvas panel. The container auto-styles semantic elements.\n\n" +
    "DESIGN: refined informational display — clean, structured, editorial. Typography and whitespace do the work. Not generic cards.\n\n" +
    "RULES:\n" +
    "- Headlines: font-family: Georgia, serif; font-weight: 500. Use h2 for topic title (19-22px, opacity 0.92), h3 for section labels (10px, uppercase, letter-spacing 0.1em, opacity 0.35). Avoid h1.\n" +
    "- Colors: ONLY var(--foreground) and var(--background). Opacity tiers: 0.92 (title), 0.88 (key values), 0.65 (body), 0.42 (secondary text), 0.25-0.3 (meta). Never hardcode colors.\n" +
    "- Metric blocks: use a grid row with joined segments — background: color-mix(in oklch, var(--foreground) 3%, transparent). First segment border-radius: 8px 0 0 8px, last: 0 8px 8px 0. Large serif numbers (22px), tiny uppercase labels (10px, 0.08em spacing, 0.32 opacity).\n" +
    "- Dividers: <div> with height: 1px, background: color-mix(in oklch, var(--foreground) 4-5%, transparent). Top accent divider can use linear-gradient(90deg, color-mix(in oklch, var(--foreground) 15%, transparent), transparent).\n" +
    "- Left accent bars for list items: width: 3px, border-radius: 2px, background: color-mix(in oklch, var(--foreground) 10%, transparent), align-self: stretch.\n" +
    "- Tables: subtle surface (2.5% foreground), border-radius 8px, overflow hidden. No header row — use label/value pairs. Cell borders: 1px solid color-mix(in oklch, var(--foreground) 4%, transparent).\n" +
    "- Source/meta: <small> with font-size: 10px, opacity 0.18-0.25, letter-spacing 0.03em.\n" +
    "- Layout: flexbox via inline styles. No <style> blocks, no class names, no scripts, no external resources.\n\n" +
    "REFERENCE — adapt this structure to any content type:\n\n" +
    '<div style="display: flex; flex-direction: column; gap: 0;">\n' +
    '  <div style="margin-bottom: 6px;">\n' +
    '    <h3 style="margin: 0 0 4px; font-size: 10px; letter-spacing: 0.12em; opacity: 0.3;">Market Overview</h3>\n' +
    '    <h2 style="font-size: 22px; font-weight: 500; opacity: 0.92; margin: 0; font-family: Georgia, serif; letter-spacing: -0.02em;">NVIDIA Corporation</h2>\n' +
    "  </div>\n" +
    '  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">\n' +
    '    <small style="font-size: 11px; opacity: 0.35; margin: 0;">NASDAQ: NVDA</small>\n' +
    '    <small style="opacity: 0.15; margin: 0;">&middot;</small>\n' +
    '    <small style="font-size: 11px; opacity: 0.3; margin: 0;">As of 3:42 PM EST</small>\n' +
    "  </div>\n" +
    '  <div style="height: 1px; background: linear-gradient(90deg, color-mix(in oklch, var(--foreground) 15%, transparent), transparent); margin-bottom: 20px;"></div>\n' +
    '  <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px; margin-bottom: 20px;">\n' +
    '    <div style="padding: 12px 14px; background: color-mix(in oklch, var(--foreground) 3%, transparent); border-radius: 8px 0 0 8px;">\n' +
    '      <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.32; margin-bottom: 6px;">Price</div>\n' +
    '      <div style="font-size: 22px; font-weight: 400; opacity: 0.88; font-family: Georgia, serif; letter-spacing: -0.02em;">$892.40</div>\n' +
    '      <div style="font-size: 11px; opacity: 0.45; margin-top: 3px;">+2.34%</div>\n' +
    "    </div>\n" +
    '    <div style="padding: 12px 14px; background: color-mix(in oklch, var(--foreground) 3%, transparent);">\n' +
    '      <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.32; margin-bottom: 6px;">Mkt Cap</div>\n' +
    '      <div style="font-size: 22px; font-weight: 400; opacity: 0.88; font-family: Georgia, serif; letter-spacing: -0.02em;">$2.19T</div>\n' +
    '      <div style="font-size: 11px; opacity: 0.45; margin-top: 3px;">Mega cap</div>\n' +
    "    </div>\n" +
    '    <div style="padding: 12px 14px; background: color-mix(in oklch, var(--foreground) 3%, transparent); border-radius: 0 8px 8px 0;">\n' +
    '      <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.32; margin-bottom: 6px;">P/E</div>\n' +
    '      <div style="font-size: 22px; font-weight: 400; opacity: 0.88; font-family: Georgia, serif; letter-spacing: -0.02em;">64.2</div>\n' +
    '      <div style="font-size: 11px; opacity: 0.45; margin-top: 3px;">TTM</div>\n' +
    "    </div>\n" +
    "  </div>\n" +
    '  <div style="margin-bottom: 20px;">\n' +
    '    <h3 style="font-size: 10px; letter-spacing: 0.1em; opacity: 0.35; margin-bottom: 10px;">Summary</h3>\n' +
    '    <p style="font-size: 12.5px; opacity: 0.55; line-height: 1.65;">Brief analysis paragraph here.</p>\n' +
    "  </div>\n" +
    '  <div style="height: 1px; background: color-mix(in oklch, var(--foreground) 5%, transparent); margin-bottom: 18px;"></div>\n' +
    '  <div style="margin-bottom: 20px;">\n' +
    '    <h3 style="font-size: 10px; letter-spacing: 0.1em; opacity: 0.35; margin-bottom: 12px;">Key Points</h3>\n' +
    '    <div style="display: flex; flex-direction: column; gap: 10px;">\n' +
    '      <div style="display: flex; gap: 10px; align-items: flex-start;">\n' +
    '        <div style="width: 3px; align-self: stretch; border-radius: 2px; background: color-mix(in oklch, var(--foreground) 10%, transparent); flex-shrink: 0; margin-top: 2px;"></div>\n' +
    '        <div>\n' +
    '          <p style="font-size: 12.5px; opacity: 0.65; margin-bottom: 3px; line-height: 1.45;"><strong style="opacity: 0.8;">Bold lead</strong> followed by supporting detail.</p>\n' +
    '          <small style="font-size: 10px; opacity: 0.25;">Source &middot; Date</small>\n' +
    "        </div>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  </div>\n" +
    '  <div style="padding-top: 8px;">\n' +
    '    <small style="font-size: 10px; opacity: 0.18; letter-spacing: 0.03em;">Sources &middot; Timestamp</small>\n' +
    "  </div>\n" +
    "</div>"
  ),
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
  WebSearch:
    "Search the web for current information.\n\n" +
    "Usage:\n" +
    "- Returns up to 6 results with title, URL, and text snippet.\n" +
    "- Use for questions requiring up-to-date information beyond training data.\n" +
    "- query should be a natural language search phrase.\n" +
    "- Search results are automatically displayed on the News panel.",
  Display:
    "Render HTML on the canvas panel of the home dashboard.\n\n" +
    "Usage:\n" +
    "- Outputs rich visual content on the home screen instead of plain text in chat.\n" +
    "- Use for ANY content that benefits from visual presentation: data, research, explanations, comparisons, formatted text.\n" +
    "- Follow the design system and reference example in the schema description exactly — same opacity tiers, same element patterns.\n" +
    "- Headlines: Georgia, serif. Section labels: h3 (10px uppercase). Metric blocks: joined grid segments with large serif numbers.\n" +
    "- Key points/items: left accent bar pattern (3px bar + content). Tables: subtle surface, no header row.\n" +
    "- Colors: ONLY var(--foreground)/var(--background) with opacity. Dividers: color-mix. Never hardcode colors.\n" +
    "- Layout via inline styles: flexbox or grid. No <style> blocks, no class names, no scripts.\n" +
    "- Adapt the reference structure to the content — stocks get metric blocks, explanations get accent-bar sections, data gets tables.",
  HeartbeatGet:
    "Get the current heartbeat configuration for this conversation.\n\n" +
    "Returns the full local heartbeat config or null if none exists.",
  HeartbeatUpsert:
    "Create or update the local heartbeat configuration for this conversation.\n\n" +
    "Usage:\n" +
    "- One heartbeat per conversation.\n" +
    "- intervalMs controls how often the local check runs (minimum 60000ms).\n" +
    "- checklist should be written as instructions Stella will follow on each run.\n" +
    "- activeHours can restrict runs to a local time window.\n" +
    "- deliver=false runs silently without posting back into the conversation.",
  HeartbeatRun:
    "Trigger the local heartbeat immediately without waiting for the next interval.",
  CronList:
    "List all local cron jobs for this device.\n\n" +
    "Returns the current local schedule state, newest first.",
  CronAdd:
    "Create a new local cron job.\n\n" +
    "Usage:\n" +
    "- Schedule types: { kind: \"at\", atMs }, { kind: \"every\", everyMs, anchorMs? }, or { kind: \"cron\", expr, tz? }.\n" +
    "- Payload types: { kind: \"systemEvent\", text } or { kind: \"agentTurn\", message }.\n" +
    "- sessionTarget=\"main\" requires systemEvent payload. sessionTarget=\"isolated\" requires agentTurn payload.\n" +
    "- deleteAfterRun=true removes successful one-shot jobs after they run.",
  CronUpdate:
    "Update an existing local cron job.\n\n" +
    "Only include the fields you want to change; omitted fields are preserved.",
  CronRemove:
    "Permanently delete a local cron job.",
  CronRun:
    "Trigger a local cron job immediately, ignoring its next scheduled time.",
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
  WebSearch: WebSearchSchema,
  Display: DisplaySchema,
} as const;

// ─── JSON Schema Map (for LLM tool definitions) ────────────────────────────
// Converts the Zod schemas above into JSON Schema objects that can be sent
// directly to LLM APIs as tool parameter definitions.

export const TOOL_JSON_SCHEMAS: Record<string, object> = Object.fromEntries(
  Object.entries(TOOL_SCHEMAS).map(([name, schema]) => [
    name,
    zodToJsonSchema(schema as unknown as Parameters<typeof zodToJsonSchema>[0], { target: "openApi3" }),
  ]),
);
