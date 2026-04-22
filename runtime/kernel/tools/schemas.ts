/**
 * Tool metadata + JSON schemas exposed to the LLM.
 *
 * Stella's General agent uses a codex-style direct tool pack
 * (exec_command, apply_patch, web, computer_*, etc.) — those tools live
 * in `registry.ts` and don't need entries here. This file declares the
 * top-level model-facing catalog: orchestrator coordination tools,
 * UI round-trips, and (for the General agent) the typed `computer_*`
 * surface that mirrors upstream computer-use MCP shape.
 */

export const DEVICE_TOOL_NAMES = [
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

const AskQuestionJsonSchema = {
  type: "object",
  description:
    "Ask the user one or more multiple-choice questions inside the chat. Renders an inline tray bubble. Questions are presented one at a time; the user picks an option for each.",
  properties: {
    questions: {
      type: "array",
      description: "Ordered list of multiple-choice questions to present.",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask. End with a question mark.",
          },
          options: {
            type: "array",
            description:
              "Up to 4 short options the user can choose between (1-5 words each).",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Option text shown next to the badge letter.",
                },
              },
              required: ["label"],
            },
          },
          allowOther: {
            type: "boolean",
            description:
              "When true, append a free-text 'Other...' option so the user can type a custom answer.",
          },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
};

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

// ── computer_* shared shapes ─────────────────────────────────────────────
// `app` accepts either an app display name ("Spotify") or a bundle id
// ("com.spotify.client"). Always required.
const COMPUTER_APP_PROPERTY = {
  type: "string",
  description:
    'The target macOS app. Use the display name ("Spotify") or the bundle id ("com.spotify.client"). Required on every call.',
};

const ComputerListAppsJsonSchema = {
  type: "object",
  properties: {},
};

const ComputerGetAppStateJsonSchema = {
  type: "object",
  properties: { app: COMPUTER_APP_PROPERTY },
  required: ["app"],
};

const ComputerClickJsonSchema = {
  type: "object",
  properties: {
    app: COMPUTER_APP_PROPERTY,
    element_index: {
      type: "string",
      description:
        "Numeric ID of the element to click, taken from the most recent get_app_state output. Provide either element_index or x/y, not both.",
    },
    x: {
      type: "number",
      description:
        "X pixel coordinate inside the most recent screenshot. Provide with y as an alternative to element_index.",
    },
    y: {
      type: "number",
      description:
        "Y pixel coordinate inside the most recent screenshot. Provide with x as an alternative to element_index.",
    },
    click_count: {
      type: "integer",
      description: "Number of clicks. Default 1. Currently only 1 is supported.",
    },
    mouse_button: {
      type: "string",
      enum: ["left", "right", "middle"],
      description: "Mouse button. Default 'left'. Currently only 'left' is supported.",
    },
  },
  required: ["app"],
};

const ComputerDragJsonSchema = {
  type: "object",
  properties: {
    app: COMPUTER_APP_PROPERTY,
    from_x: { type: "number", description: "Start X pixel in the screenshot." },
    from_y: { type: "number", description: "Start Y pixel in the screenshot." },
    to_x: { type: "number", description: "End X pixel in the screenshot." },
    to_y: { type: "number", description: "End Y pixel in the screenshot." },
  },
  required: ["app", "from_x", "from_y", "to_x", "to_y"],
};

const ComputerPerformSecondaryActionJsonSchema = {
  type: "object",
  properties: {
    app: COMPUTER_APP_PROPERTY,
    element_index: {
      type: "string",
      description:
        "Numeric ID of the element from the most recent get_app_state output.",
    },
    action: {
      type: "string",
      description:
        "AX action name to invoke (e.g. AXPress, AXRaise, AXShowMenu). The element's get_app_state line lists its supported Secondary Actions.",
    },
  },
  required: ["app", "element_index", "action"],
};

const ComputerPressKeyJsonSchema = {
  type: "object",
  properties: {
    app: COMPUTER_APP_PROPERTY,
    key: {
      type: "string",
      description:
        "Key or key combination (e.g. 'Return', 'Tab', 'cmd+f', 'cmd+shift+l').",
    },
  },
  required: ["app", "key"],
};

const ComputerScrollJsonSchema = {
  type: "object",
  properties: {
    app: COMPUTER_APP_PROPERTY,
    element_index: {
      type: "string",
      description:
        "Numeric ID of the scrollable element from the most recent get_app_state output.",
    },
    direction: {
      type: "string",
      enum: ["up", "down", "left", "right"],
      description: "Scroll direction.",
    },
    pages: {
      type: "number",
      description: "Number of pages to scroll. Default 1.",
    },
  },
  required: ["app", "element_index", "direction"],
};

const ComputerSetValueJsonSchema = {
  type: "object",
  properties: {
    app: COMPUTER_APP_PROPERTY,
    element_index: {
      type: "string",
      description:
        "Numeric ID of the settable element (text field, search field, switch, slider).",
    },
    value: {
      type: "string",
      description: "New value to set. May be empty to clear the field.",
    },
  },
  required: ["app", "element_index", "value"],
};

const ComputerTypeTextJsonSchema = {
  type: "object",
  properties: {
    app: COMPUTER_APP_PROPERTY,
    text: { type: "string", description: "Literal text to type." },
  },
  required: ["app", "text"],
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

// Codex-style shell schema. Mirrors the surface from
// https://github.com/openai/codex/blob/main/codex-rs/tools/src/local_tool.rs
// so models that already know Codex's contract transfer 1:1.
const ExecCommandJsonSchema = {
  type: "object",
  properties: {
    cmd: {
      type: "string",
      description: "Shell command to execute.",
    },
    workdir: {
      type: "string",
      description:
        "Optional working directory to run the command in; defaults to the turn cwd.",
    },
    shell: {
      type: "string",
      description:
        "Shell binary to launch. Defaults to the user's default shell.",
    },
    tty: {
      type: "boolean",
      description:
        "Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY.",
    },
    yield_time_ms: {
      type: "number",
      description:
        "How long to wait (in milliseconds) for output before yielding control back to you with a session_id.",
    },
    max_output_tokens: {
      type: "number",
      description: "Maximum number of tokens to return. Excess output is truncated.",
    },
    login: {
      type: "boolean",
      description:
        "Whether to run the shell with -l/-i semantics. Defaults to true.",
    },
  },
  required: ["cmd"],
};

const WriteStdinJsonSchema = {
  type: "object",
  properties: {
    session_id: {
      type: "number",
      description: "Identifier of a still-running exec_command session.",
    },
    chars: {
      type: "string",
      description:
        "Bytes to write to stdin. May be empty to poll for more output without sending input.",
    },
    yield_time_ms: {
      type: "number",
      description:
        "How long to wait (in milliseconds) for output before yielding.",
    },
    max_output_tokens: {
      type: "number",
      description: "Maximum number of tokens to return. Excess output is truncated.",
    },
  },
  required: ["session_id"],
};

// Codex's JSON variant of apply_patch. Single `input` string carrying a full
// `*** Begin Patch` ... `*** End Patch` envelope. Works on every model the
// freeform Lark grammar variant doesn't.
const ApplyPatchJsonSchema = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description: "The entire contents of the apply_patch envelope.",
    },
  },
  required: ["input"],
};

const ViewImageJsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Local filesystem path to an image file.",
    },
  },
  required: ["path"],
};

// Stella-specific. Codex offloads search and fetch to the OpenAI Responses
// built-in tools; we route through Exa (search) + a local fetcher.
const WebJsonSchema = {
  type: "object",
  description:
    "Either search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url.",
  properties: {
    query: {
      type: "string",
      description:
        "Web search query. Returns ranked results with title, URL, and snippet.",
    },
    url: {
      type: "string",
      description:
        "URL to fetch. Returns the page rendered as readable text with HTML stripped.",
    },
    category: {
      type: "string",
      description:
        "Optional Exa category hint when using query (e.g. 'news', 'company', 'research_paper').",
    },
    prompt: {
      type: "string",
      description:
        "Optional follow-up prompt used by the local fetcher to extract just the relevant slice of a long page.",
    },
  },
};

// Stella-specific media gateway wrapper.
const ImageGenJsonSchema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "Description of the image to generate. Be specific about subject, style, framing, color, lighting, and any text overlays.",
    },
    aspectRatio: {
      type: "string",
      description:
        "Optional aspect ratio (e.g. '1:1', '16:9', '9:16', '4:3'). Defaults to the gateway's recommended ratio.",
    },
    referenceImagePaths: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional local image paths to use as references (style/character/scene continuity).",
    },
  },
  required: ["prompt"],
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  AskUserQuestion:
    "Ask the user to choose between options via a UI prompt. Use for clarifications, decisions, or preferences.",
  askQuestion:
    "Ask the user one or more multiple-choice questions inline in the chat. Use when you need a quick decision the user can make by tapping an option. Renders a fade-in questions tray bubble.",
  RequestCredential:
    "Request an API key or secret via a secure UI prompt. Returns a `secretId` handle that can be passed to other tools/integrations.",
  Schedule:
    "Handle local scheduling requests in plain language. Delegates to the schedule specialist and returns a short summary.",
  web:
    "Search the live web (provide query) or fetch a known URL (provide url). Pass exactly one of query or url. Use this for facts that change over time, recent news, current documentation, or any specific page you need to read.",
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
  exec_command:
    "Run a shell command in a PTY. Returns immediate output, or a session_id if the process is still running so you can poll/interact via write_stdin. Required: cmd. Stella CLIs (stella-browser, stella-office, stella-ui, stella-computer) are auto-injected into PATH.",
  write_stdin:
    "Continue an existing exec_command session: write characters to its stdin and read recent output. Pass empty chars to poll without sending input. Required: session_id.",
  apply_patch:
    "Edit files via a *** Begin Patch / *** End Patch envelope. Supports Add File, Update File (with optional Move to), Delete File. Each Update File hunk is anchored by 3 lines of context above and below the change. Required: input (the full patch text).",
  view_image:
    "Read a local image file from the filesystem and attach it to the conversation as a vision input. Use only when the user gives you an explicit absolute file path. Required: path.",
  image_gen:
    "Generate a still image through Stella's managed media gateway. The result is saved under state/media/outputs/ and shown in the sidebar; do not download or open it yourself. Required: prompt.",
  // macOS computer-use surface. Drive any macOS app in the background through
  // Accessibility — never raises the target, never steals focus. Always pass
  // `app` as a name like "Spotify" or a bundle id like "com.apple.Notes".
  computer_list_apps:
    "List the apps on this macOS device (running + recently used). Returns app name, bundle id, pid, last-used date, and active state.",
  computer_get_app_state:
    "Start a computer-use session for an app if needed, then return its current accessibility tree (compact numbered element list) and a screenshot of its key window. Call this once per turn before interacting with the app. Required: app.",
  computer_click:
    "Click an element of the target app. Provide either element_index (numeric ID from the latest get_app_state) for an Accessibility click, or x and y (screenshot pixels) for a coordinate click. Required: app.",
  computer_drag:
    "Drag from one screenshot pixel to another inside the target app's captured window. Required: app, from_x, from_y, to_x, to_y.",
  computer_perform_secondary_action:
    "Invoke a secondary Accessibility action (e.g. AXPress on a menu item, AXRaise on a window) exposed by an element. Required: app, element_index, action.",
  computer_press_key:
    "Press a key or key combination on the keyboard with the target app focused. Supports modifiers (cmd, shift, ctrl, alt) and named keys (Return, Tab, Up, Down, etc). Required: app, key.",
  computer_scroll:
    "Scroll an element of the target app in a direction by a number of pages. Required: app, element_index, direction (up|down|left|right).",
  computer_set_value:
    "Set the value of a settable Accessibility element (text field, search field, switch, slider). Deterministic — does not depend on focus. Required: app, element_index, value.",
  computer_type_text:
    "Type literal text via the keyboard into the target app. Required: app, text.",
  // Internal-only descriptors (Explore subagent uses Read/Grep).
  Read: "Read a file from the filesystem (internal).",
  Grep: "Search file contents using ripgrep (internal).",
};

export const TOOL_JSON_SCHEMAS: Record<string, object> = {
  AskUserQuestion: AskUserQuestionJsonSchema,
  askQuestion: AskQuestionJsonSchema,
  RequestCredential: RequestCredentialJsonSchema,
  Schedule: ScheduleJsonSchema,
  web: WebJsonSchema,
  Display: DisplayJsonSchema,
  DisplayGuidelines: DisplayGuidelinesJsonSchema,
  TaskCreate: TaskCreateJsonSchema,
  TaskOutput: TaskOutputJsonSchema,
  TaskPause: TaskPauseJsonSchema,
  TaskUpdate: TaskUpdateJsonSchema,
  Memory: MemoryJsonSchema,
  Dream: DreamJsonSchema,
  StrReplace: StrReplaceJsonSchema,
  exec_command: ExecCommandJsonSchema,
  write_stdin: WriteStdinJsonSchema,
  apply_patch: ApplyPatchJsonSchema,
  view_image: ViewImageJsonSchema,
  image_gen: ImageGenJsonSchema,
  computer_list_apps: ComputerListAppsJsonSchema,
  computer_get_app_state: ComputerGetAppStateJsonSchema,
  computer_click: ComputerClickJsonSchema,
  computer_drag: ComputerDragJsonSchema,
  computer_perform_secondary_action: ComputerPerformSecondaryActionJsonSchema,
  computer_press_key: ComputerPressKeyJsonSchema,
  computer_scroll: ComputerScrollJsonSchema,
  computer_set_value: ComputerSetValueJsonSchema,
  computer_type_text: ComputerTypeTextJsonSchema,
  Read: ReadJsonSchema,
  Grep: GrepJsonSchema,
};
