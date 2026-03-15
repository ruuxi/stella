/**
 * Frontend-local tool metadata and schemas for the PI runtime.
 *
 * The PI runtime currently consumes the tool names, descriptions, and safety
 * helpers from this module.
 *
 * Schemas are plain JSON Schema objects — no Zod, no conversion libraries.
 */

// ─── Device Tool Names ──────────────────────────────────────────────────────

export const DEVICE_TOOL_NAMES = [
  "Read",
  "Write",
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
  "Schedule",
  "Display",
  "DisplayGuidelines",
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

// ─── JSON Schemas (plain objects) ───────────────────────────────────────────
// Each schema is a standard JSON Schema object passed directly to LLM tool
// definitions. No conversion step needed.

const ReadJsonSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Absolute path to the file to read" },
    offset: { type: "number", description: "Line number to start reading from (1-based)" },
    limit: { type: "number", description: "Max number of lines to read" },
  },
  required: ["file_path"],
};

const WriteJsonSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Absolute path to the file to write" },
    content: { type: "string", description: "Full file contents to write" },
  },
  required: ["file_path", "content"],
};

const EditJsonSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Absolute path to the file to edit" },
    old_string: { type: "string", description: "Exact text to find and replace (must be unique unless replace_all=true)" },
    new_string: { type: "string", description: "Replacement text" },
    replace_all: { type: "boolean", description: "Replace all occurrences instead of requiring uniqueness" },
  },
  required: ["file_path", "old_string", "new_string"],
};

const GlobJsonSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Glob pattern to match (e.g. \"**/*.ts\", \"src/**/*.json\")" },
    path: { type: "string", description: "Directory to search in (defaults to working directory)" },
  },
  required: ["pattern"],
};

const GrepJsonSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regex pattern to search for" },
    path: { type: "string", description: "File or directory to search in" },
    glob: { type: "string", description: "Filter files by glob pattern (e.g. \"*.tsx\")" },
    type: { type: "string", description: "Filter by file type (e.g. \"ts\", \"py\", \"json\")" },
    output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "What to return: matching lines, file paths, or counts" },
    case_insensitive: { type: "boolean", description: "Case-insensitive search" },
    context_lines: { type: "number", description: "Lines of context around each match (for output_mode=content)" },
    max_results: { type: "number", description: "Maximum number of results to return" },
  },
  required: ["pattern"],
};

const BashJsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "The shell command to execute" },
    description: { type: "string", description: "Human-readable description of what this command does" },
    timeout: { type: "number", description: "Timeout in milliseconds (default 120000, max 600000)" },
    working_directory: { type: "string", description: "Working directory for the command" },
    run_in_background: { type: "boolean", description: "Run in background and return a shell_id immediately" },
  },
  required: ["command"],
};

const KillShellJsonSchema = {
  type: "object",
  properties: {
    shell_id: { type: "string", description: "Shell ID returned by Bash with run_in_background=true" },
  },
  required: ["shell_id"],
};

const ShellStatusJsonSchema = {
  type: "object",
  properties: {
    shell_id: { type: "string", description: "Shell ID to check. Omit to list all shells." },
    tail_lines: { type: "number", description: "Number of output lines to return from the end (default 50)" },
  },
};

const AskUserQuestionJsonSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask (end with ?)" },
          header: { type: "string", description: "Short label displayed as a tag (max 12 chars)" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Option text (1-5 words)" },
                description: { type: "string", description: "What this option means or what happens if chosen" },
              },
              required: ["label", "description"],
            },
          },
          multiSelect: { type: "boolean", description: "Allow selecting multiple options" },
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
    provider: { type: "string", description: "Unique key for this secret (e.g. \"github_token\")" },
    label: { type: "string", description: "Display name shown to the user (e.g. \"GitHub Token\")" },
    description: { type: "string", description: "Why this credential is needed" },
    placeholder: { type: "string", description: "Input placeholder text" },
  },
  required: ["provider"],
};

const SkillBashJsonSchema = {
  type: "object",
  properties: {
    skill_id: { type: "string", description: "ID of the skill whose secrets to mount" },
    command: { type: "string", description: "Shell command to execute" },
    description: { type: "string", description: "Human-readable description of what this command does" },
    timeout: { type: "number", description: "Timeout in milliseconds (default 120000, max 600000)" },
    working_directory: { type: "string", description: "Working directory for the command" },
    run_in_background: { type: "boolean", description: "Run in background and return a shell_id" },
  },
  required: ["skill_id", "command"],
};

const MediaGenerateJsonSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["generate", "edit"], description: "Create new or edit existing (default: generate)" },
    media_type: { type: "string", enum: ["image", "video"], description: "Type of media to produce (default: image)" },
    prompt: { type: "string", description: "Description of what to generate or how to edit" },
    source_url: { type: "string", description: "URL of source media to edit (required for mode=edit)" },
  },
  required: ["prompt"],
};

const ScheduleJsonSchema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "Plain-language scheduling request for local cron jobs and heartbeats.",
    },
  },
  required: ["prompt"],
};

const WebSearchJsonSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Natural language search query — write descriptively, not as keywords" },
    category: { type: "string", enum: ["company", "people", "research paper"], description: "Optional filter. 'company' for company research, 'people' for non-public figures, 'research paper' for academic papers. Omit for news, sports, general facts." },
  },
  required: ["query"],
};

const DisplayJsonSchema = {
  type: "object",
  properties: {
    i_have_read_guidelines: {
      type: "boolean",
      description: "Confirm you have already called DisplayGuidelines in this conversation.",
    },
    html: {
      type: "string",
      description:
        "HTML or SVG content to render. For SVG: raw SVG starting with <svg>. " +
        "For HTML: raw content fragment, no DOCTYPE/<html>/<head>/<body>.",
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
        enum: ["interactive", "chart", "mockup", "art", "diagram"],
      },
      description: "Which module(s) to load. Pick all that fit.",
    },
  },
  required: ["modules"],
};

const TaskCreateJsonSchema = {
  type: "object",
  properties: {
    description: { type: "string", description: "Short summary of the task (shown in task list)" },
    prompt: { type: "string", description: "Detailed instructions for the subagent — this is the agent's ONLY context" },
    subagent_type: { type: "string", enum: ["general", "self_mod", "explore", "app"], description: "Which agent executes the task: 'general' (external code/files/shell work), 'self_mod' (Stella code, Stella UI, Stella runtime), 'explore' (read-only codebase search), 'app' (browser/desktop app automation). Default: general" },
    thread_name: { type: "string", description: "Existing thread name to continue. Omit to start fresh and the runtime will assign a short name automatically." },
    command_id: { type: "string", description: "Command ID from a suggestion chip — system injects full instructions automatically" },
  },
  required: ["description", "prompt"],
};

const TaskOutputJsonSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "Task ID returned by TaskCreate" },
  },
  required: ["task_id"],
};

const TaskCancelJsonSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "Task ID to cancel" },
  },
  required: ["task_id"],
};

const TaskJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "cancel", "message", "inbox"], description: "Action to perform: 'create' (new task), 'cancel' (stop task), 'message' (send to task), 'inbox' (read messages from task)" },
    task_id: { type: "string", description: "Task ID (required for cancel, message, inbox)" },
    description: { type: "string", description: "Task summary (for create)" },
    prompt: { type: "string", description: "Detailed instructions (for create)" },
    subagent_type: { type: "string", description: "Agent type (for create): general, self_mod, explore, or app" },
    message: { type: "string", description: "Message content (for action=message)" },
  },
  required: ["action"],
};

const WebFetchJsonSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to fetch (HTTP auto-upgrades to HTTPS)" },
    prompt: { type: "string", description: "What information you want from this page" },
  },
  required: ["url"],
};

const SaveMemoryJsonSchema = {
  type: "object",
  properties: {
    content: { type: "string", description: "Text to save as a memory entry" },
    tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization" },
  },
  required: ["content"],
};

const RecallMemoriesJsonSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query to find relevant memories" },
    limit: { type: "number", description: "Maximum number of memories to return" },
  },
  required: ["query"],
};

const ActivateSkillJsonSchema = {
  type: "object",
  properties: {
    skill_id: { type: "string", description: "ID of the skill to activate" },
  },
  required: ["skill_id"],
};

const NoResponseJsonSchema = {
  type: "object",
  properties: {},
};

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
  Write:
    "Write a full file to the local filesystem.\n\n" +
    "Usage:\n" +
    "- file_path must be an absolute path.\n" +
    "- content replaces the full file contents.\n" +
    "- Creates parent directories when needed.\n" +
    "- Use this for new files or intentional full-file replacements.\n" +
    "- Prefer Edit for targeted changes to existing files.",
  Edit:
    "Make exact string replacements in a file.\n\n" +
    "Usage:\n" +
    "- Review the file content first (prefer Read; Bash is also fine). This tool will fail if you haven't seen the file.\n" +
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
    "- Use Bash for shell commands, scripts, process control, package installs, and CLI tools.\n" +
    "- Prefer Read, Write, and Edit for repo file inspection and modifications.\n" +
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
  Schedule:
    "Handle local scheduling requests in plain language.\n\n" +
    "Usage:\n" +
    "- Provide a natural-language prompt describing the cron jobs and/or heartbeat behavior you want.\n" +
    "- This tool uses a one-off scheduling specialist behind the scenes.\n" +
    "- Use this instead of calling the low-level cron and heartbeat tools directly.",
  WebSearch:
    "Search the web via Exa for current information.\n\n" +
    "Use natural language queries, not keywords (e.g. 'Tesla current stock performance' not 'TSLA stock price').\n" +
    "Returns up to 5 results with title, URL, and highlighted excerpts.\n" +
    "Returns text results. Use Display to present them visually when appropriate.\n\n" +
    "WHEN TO SEARCH: current events, recent news, facts/stats that change over time, " +
    "product/company info, prices, people's current roles, documentation, comparisons between evolving products.\n" +
    "WHEN NOT TO SEARCH: general knowledge, coding help, creative writing, opinions, well-established historical facts, definitions.\n" +
    "PARTIAL SEARCH: If a query mixes static knowledge with time-sensitive info, only search the time-sensitive parts.\n\n" +
    "CATEGORIES — use sparingly, most queries should omit:\n" +
    "- 'company': only for 'what does X company do' style company research.\n" +
    "- 'people': only for non-public figures (e.g. finding a professional's profile). Never for public figures, quotes, or news about someone.\n" +
    "- 'research paper': only for academic papers or arxiv.\n" +
    "For news, sports, general facts — do NOT set a category.\n\n" +
    "FOLLOW-UPS: In multi-turn conversations, expand referential language — " +
    "'competitors' should include the specific company being discussed, 'how do I set it up' should include what 'it' refers to.",
  Display:
    "Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — on the canvas panel. " +
    "Use for flowcharts, dashboards, forms, calculators, data tables, games, illustrations, or any visual content. " +
    "The content is rendered with full CSS/JS support including Canvas and CDN libraries. " +
    "IMPORTANT: Call DisplayGuidelines once before your first Display call.",
  DisplayGuidelines:
    "Returns design guidelines for Display (CSS patterns, colors, typography, layout rules, examples). " +
    "Call once before your first Display call. Do NOT mention this call to the user — it is an internal setup step.",
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
  TaskCreate:
    "Create a background task executed by a specialized subagent.\n\n" +
    "Usage:\n" +
    "- description: short summary shown in the task list.\n" +
    "- prompt: detailed instructions — the subagent's ONLY context. Include the user's request, relevant file paths, and expected output.\n" +
    "- subagent_type: 'general' (external code, files, shell work), 'self_mod' (Stella code, Stella UI, Stella runtime), 'explore' (read-only codebase search), or 'app' (browser and desktop app automation).\n" +
    "- thread_name: optional active thread name to continue. Omit it to start fresh and the runtime will assign a short Greek/Roman name automatically.\n" +
    "- Returns a task_id for tracking with TaskOutput or canceling with TaskCancel.",
  TaskOutput:
    "Check the status and output of a previously created task.\n\n" +
    "Usage:\n" +
    "- task_id: the ID returned by TaskCreate.\n" +
    "- Returns the task's current status (running/completed/error) and result or error text.",
  TaskCancel:
    "Cancel a running task.\n\n" +
    "Usage:\n" +
    "- task_id: the ID of the task to cancel.",
  Task:
    "Multi-action task tool for creating tasks, sending messages to running tasks, and reading task inbox.\n\n" +
    "Actions:\n" +
    "- action='create': Create a new subagent task (same as TaskCreate).\n" +
    "- action='cancel': Cancel a running task by task_id.\n" +
    "- action='message': Send a message to a running task's agent.\n" +
    "- action='inbox': Read messages sent back from a task's agent.",
  WebFetch:
    "Fetch and read content from a URL.\n\n" +
    "Usage:\n" +
    "- Fetches the page, strips HTML tags, and returns plain text.\n" +
    "- HTTP URLs are auto-upgraded to HTTPS.\n" +
    "- prompt describes what information you want to extract.\n" +
    "- Content is truncated to ~30,000 characters.",
  SaveMemory:
    "Save information worth remembering across conversations.\n\n" +
    "Usage:\n" +
    "- content: the text to remember (preferences, decisions, facts, personal details).\n" +
    "- tags: optional array of strings for categorization.\n" +
    "- The system auto-deduplicates similar entries.",
  RecallMemories:
    "Look up past context from saved memories.\n\n" +
    "Usage:\n" +
    "- query: search text to find relevant memories.\n" +
    "- limit: optional max number of results.\n" +
    "- Use when the user references past conversations, preferences, or you need prior context.",
  ActivateSkill:
    "Load an installed skill's full instructions into the current session.\n\n" +
    "Usage:\n" +
    "- skill_id: exact ID of an installed skill (e.g. 'electron').\n" +
    "- Only use skill IDs listed in your agent config (defaultSkills) or that you have confirmed exist.\n" +
    "- Do NOT guess or invent skill IDs — if the skill doesn't exist, it will fail.",
  NoResponse:
    "Signal that you have nothing to say right now.\n\n" +
    "Call this instead of generating a message when a system event, task result, or heartbeat check " +
    "does not warrant a visible response. Do NOT call this for user messages — always reply to users.",
};

// ─── JSON Schema Map (for LLM tool definitions) ────────────────────────────

export const TOOL_JSON_SCHEMAS: Record<string, object> = {
  Read: ReadJsonSchema,
  Write: WriteJsonSchema,
  Edit: EditJsonSchema,
  Glob: GlobJsonSchema,
  Grep: GrepJsonSchema,
  Bash: BashJsonSchema,
  KillShell: KillShellJsonSchema,
  ShellStatus: ShellStatusJsonSchema,
  AskUserQuestion: AskUserQuestionJsonSchema,
  RequestCredential: RequestCredentialJsonSchema,
  SkillBash: SkillBashJsonSchema,
  MediaGenerate: MediaGenerateJsonSchema,
  Schedule: ScheduleJsonSchema,
  WebSearch: WebSearchJsonSchema,
  Display: DisplayJsonSchema,
  DisplayGuidelines: DisplayGuidelinesJsonSchema,
  TaskCreate: TaskCreateJsonSchema,
  TaskOutput: TaskOutputJsonSchema,
  TaskCancel: TaskCancelJsonSchema,
  Task: TaskJsonSchema,
  WebFetch: WebFetchJsonSchema,
  SaveMemory: SaveMemoryJsonSchema,
  RecallMemories: RecallMemoriesJsonSchema,
  ActivateSkill: ActivateSkillJsonSchema,
  NoResponse: NoResponseJsonSchema,
};
