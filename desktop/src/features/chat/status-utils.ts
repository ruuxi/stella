/**
 * Compute a user-friendly status message for the working indicator
 * based on which orchestrator tool is currently in flight.
 *
 * Only the orchestrator's tool surface lives here — anything a general
 * agent runs is rolled up into a "Working on it" task line by the
 * agent-management indicators, not the per-tool status. Keep the copy
 * short, sentence-case, conversational, and in Stella's voice.
 *
 * Each tool has a small pool of variations. The pick is seeded by the
 * tool call's stable id so the label stays put for the duration of one
 * call (no flicker on re-renders), but feels different across calls.
 */
/**
 * Stella always presents as a single assistant — never expose that
 * `spawn_agent`, `send_input`, and `pause_agent` orchestrate
 * other agents under the hood. Those tools just get generic "Stella is doing
 * the work" copy.
 */
const AGENT_WORK_VARIATIONS: readonly string[] = [
  "On it",
  "Working on it",
  "Got it",
  "Handling it",
  "Taking care of it",
  "Sorting it",
  "Doing the thing",
  "Making it happen",
  "Just a sec",
  "One moment",
];

const TOOL_STATUS_BY_NAME: Record<string, readonly string[]> = {
  image_gen: [
    "Sketching",
    "Drawing",
    "Sketching it out",
    "Drawing it up",
    "Mocking it up",
    "Painting a picture",
    "Whipping up a visual",
    "Making an image",
    "Starting the render",
    "Setting the scene",
  ],
  web: [
    "Searching",
    "Looking it up",
    "Googling",
    "Checking online",
    "Searching the web",
    "Looking that up",
    "Browsing",
    "Hunting it down",
    "Asking the internet",
    "Finding out",
  ],
  schedule: [
    "Scheduling",
    "Calendaring",
    "Penciling it in",
    "Booking it",
    "Saving the date",
    "Adding to your calendar",
    "Locking in the time",
    "Marking it down",
    "Setting a reminder",
    "Putting it on the schedule",
  ],
  context: [
    "Looking back",
    "Checking my notes",
    "Checking recent notes",
    "Finding the thread",
    "Looking for the reference",
    "Checking recent activity",
    "Finding the background",
    "Catching up",
    "Getting oriented",
    "Looking at what matters",
  ],
  // Recall delegates to a recall agent that greps the memory ledger and
  // past threads — often the orchestrator's longest wait, so the copy
  // must read as memory-digging rather than generic thinking.
  recall: [
    "Searching my memory",
    "Digging through history",
    "Jogging my memory",
    "Thinking back",
    "Retracing our steps",
    "Flipping through old notes",
    "Rummaging through the archives",
    "Pulling up past threads",
    "Checking what we did before",
    "Dusting off the records",
  ],
  remember: [
    "Making a note",
    "Filing that away",
    "Writing it down",
    "Committing it to memory",
    "Jotting that down",
    "Saving that for later",
    "Tucking it away",
    "Adding it to my notes",
  ],
  spawn_agent: AGENT_WORK_VARIATIONS,
  send_input: AGENT_WORK_VARIATIONS,
  pause_agent: [
    "Pausing",
    "Holding up",
    "Hitting pause",
    "Putting a pin in it",
    "Holding off",
    "Taking a beat",
    "Easing off",
    "Slowing down",
    "Putting it on hold",
    "Standing by",
  ],

  // ── General-agent + subagent tools ──────────────────────────────────────
  // These run inside spawned agents. Raw `Running <toolName>` status text maps
  // through this same table so the bare tool identifier never reaches the
  // working indicator. Keep the first entry as the canonical phrase.
  exec_command: [
    "Running it",
    "Working on it",
    "Running a command",
    "Getting it done",
    "On it",
    "Handling it",
    "Making it happen",
    "Just a sec",
  ],
  bash: [
    "Running it",
    "Working on it",
    "Running a command",
    "Getting it done",
    "On it",
    "Handling it",
  ],
  read: [
    "Reading",
    "Looking it over",
    "Taking a look",
    "Reading through",
    "Checking the file",
    "Skimming it",
    "Pulling it up",
    "Having a read",
  ],
  write: [
    "Writing",
    "Saving it",
    "Writing it out",
    "Putting it down",
    "Drafting the file",
    "Getting it written",
    "Setting it up",
  ],
  edit: [
    "Editing",
    "Making changes",
    "Tweaking it",
    "Updating it",
    "Refining it",
    "Adjusting things",
    "Touching it up",
  ],
  apply_patch: [
    "Making changes",
    "Applying the changes",
    "Editing the code",
    "Patching it",
    "Wiring it up",
    "Putting it together",
    "Updating the code",
  ],
  str_replace: [
    "Editing",
    "Making changes",
    "Tweaking it",
    "Updating the text",
    "Swapping things out",
    "Refining it",
  ],
  grep: [
    "Searching",
    "Looking it up",
    "Hunting it down",
    "Scanning through",
    "Finding it",
    "Digging in",
    "Searching the files",
  ],
  glob: [
    "Looking for files",
    "Finding files",
    "Scanning the folder",
    "Searching files",
    "Tracking files down",
    "Browsing files",
  ],
  view_image: [
    "Taking a look",
    "Viewing the image",
    "Checking the image",
    "Looking at it",
    "Studying the picture",
    "Examining it",
  ],
  write_stdin: [
    "Sending input",
    "Typing it in",
    "Passing it along",
    "Feeding it in",
    "Responding",
    "Sending it over",
  ],
  tool_search: [
    "Finding the right tool",
    "Looking for tools",
    "Picking a tool",
    "Searching tools",
    "Lining up the tools",
    "Choosing how",
  ],
  request_credential: [
    "Asking for access",
    "Requesting access",
    "Getting permission",
    "Lining up access",
    "Checking access",
    "Asking to connect",
  ],
  multi_tool_use_parallel: [
    "Juggling a few things",
    "Doing several things",
    "Working in parallel",
    "Handling a few things",
    "Multitasking",
    "Running things together",
  ],
  dream: [
    "Thinking it over",
    "Mulling it over",
    "Reflecting",
    "Turning it over",
    "Working it out",
    "Connecting the dots",
  ],
  import_source: [
    "Pulling it in",
    "Importing it",
    "Bringing it in",
    "Loading the source",
    "Fetching it",
    "Reading it in",
  ],
  script_draft: [
    "Drafting",
    "Sketching it out",
    "Writing the script",
    "Putting it together",
    "Outlining it",
    "Drafting the steps",
  ],
  html: [
    "Building it",
    "Putting it together",
    "Laying it out",
    "Designing it",
    "Mocking it up",
    "Drafting the page",
  ],
  task: [
    "On it",
    "Handling it",
    "Working on it",
    "Taking care of it",
    "Getting it done",
    "Making it happen",
  ],

  // Schedule subagent
  cron_add: ["Scheduling it", "Setting it up", "Adding it", "Penciling it in", "Booking it"],
  cron_list: ["Checking the schedule", "Looking at what's planned", "Reviewing the schedule", "Pulling up the schedule"],
  cron_remove: ["Clearing it", "Removing it", "Canceling it", "Taking it off the schedule"],
  cron_run: ["Running it", "Kicking it off", "Triggering it", "Setting it in motion"],
  cron_update: ["Updating the schedule", "Adjusting it", "Rescheduling", "Tweaking the timing"],
  heartbeat_get: ["Checking in", "Taking a pulse", "Checking status", "Seeing how it's going"],
  heartbeat_run: ["Running a check", "Checking in", "Taking a pulse", "Testing it"],
  heartbeat_upsert: ["Saving the status", "Updating the check-in", "Logging it", "Recording it"],

  // Fashion subagent
  fashion_search_products: ["Browsing pieces", "Hunting for looks", "Searching the racks", "Finding options", "Pulling pieces"],
  fashion_get_product_details: ["Checking the details", "Looking it up", "Reading the specs", "Studying the piece"],
  fashion_get_context: ["Checking your style", "Reading your taste", "Pulling your preferences", "Getting the vibe"],
  fashion_create_outfit: ["Styling a look", "Putting a look together", "Building the outfit", "Pulling it together", "Crafting the fit"],
  fashion_create_checkout: ["Setting up checkout", "Getting the order ready", "Building the cart", "Prepping the order"],
  fashion_mark_outfit_ready: ["Finishing the look", "Wrapping it up", "Finalizing the fit", "Calling it ready"],
  fashion_mark_outfit_failed: ["Reworking it", "Noting the issue", "Adjusting course", "Trying again"],

  // iMessage / Linq subagent
  linq_send_message: ["Texting them", "Sending the message", "Firing off a text", "Writing back", "Replying"],
  linq_react_to_message: ["Reacting", "Adding a reaction", "Tapping back", "Responding"],
  linq_send_voice_memo: ["Recording a memo", "Sending a voice note", "Recording it", "Sending audio"],
  linq_share_contact_card: ["Sharing the contact", "Sending the card", "Passing it along", "Sharing details"],
};

// Verb-prefixed tool status emitted by the runtime when a tool does not
// provide its own display text. Capturing group 1 is the bare tool identifier.
const RAW_TOOL_STATUS_PATTERN =
  /^(?:running|executing|calling|invoking)\s+(.+)$/i;

/**
 * Normalize a tool identifier to the snake_case keys used in
 * `TOOL_STATUS_BY_NAME`. Handles the runtime's mixed naming — snake_case
 * (`spawn_agent`), PascalCase (`Recall`, `RequestCredential`, `CronAdd`)
 * and space-separated humanized labels (`Running Spawn Agent`).
 */
const toToolStatusKey = (value: string): string =>
  value
    .trim()
    // Acronym → word boundary first (`HTMLPreview` → `HTML_Preview`) so
    // consecutive capitals don't collapse into one token below.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[_\s-]+/g, "_")
    .replace(/:+$/g, "")
    .toLowerCase();

/**
 * Turn raw tool status text into the same friendly copy as direct tool-name
 * rendering, while leaving genuine human-readable status text untouched.
 */
export function normalizeDisplayStatusText(
  statusText: string | undefined,
): string | undefined {
  if (!statusText) return undefined;
  const trimmed = statusText.trim();
  if (!trimmed) return undefined;
  const match = RAW_TOOL_STATUS_PATTERN.exec(statusText.trim());
  if (!match) return trimmed;
  const rawToolName = match[1]!;
  const toolName = toToolStatusKey(rawToolName);
  if (rawToolName.includes(" ") && !TOOL_STATUS_BY_NAME[toolName]) {
    return trimmed;
  }
  return computeStatus({ toolName, seed: "" });
}

const IDLE_VARIATIONS: readonly string[] = [
  "Thinking",
  "Mulling it over",
  "Figuring it out",
  "Working it out",
  "Putting it together",
  "Lining things up",
  "Weighing options",
  "Settling on a plan",
  "Sorting it out",
  "Considering",
];

const REASONING_VARIATIONS: readonly string[] = [
  "Thinking",
  "Mulling it over",
  "Working through it",
  "Turning it over",
  "Reasoning",
  "Chewing on this",
  "Connecting the dots",
  "Sitting with it",
  "Untangling it",
  "Piecing it together",
];

const FALLBACK_VARIATIONS: readonly string[] = [
  "Working on it",
  "On it",
  "Just a sec",
  "One moment",
  "Handling it",
  "Looking into it",
  "On the case",
];

/**
 * Stable string-hash (FNV-1a, 32-bit). Deterministic per-seed so the
 * same tool call always picks the same variation, but spreads small
 * inputs (request ids, tool names) across the variation pool.
 */
const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Mask to unsigned 32-bit so the modulo below stays non-negative.
  return hash >>> 0;
};

const pickVariation = (
  options: readonly string[],
  seed: string | undefined,
): string => {
  if (options.length === 0) return "";
  if (options.length === 1 || !seed) return options[0]!;
  return options[hashSeed(seed) % options.length]!;
};

export function computeStatus({
  toolName,
  seed,
  isReasoning,
}: {
  toolName?: string;
  /** Stable id (e.g. tool call request id) used to lock in one
   * variation per call. Without it, the first variation is used. */
  seed?: string;
  isReasoning?: boolean;
} = {}): string {
  if (toolName) {
    const normalizedToolName = toToolStatusKey(toolName);
    const mapped = TOOL_STATUS_BY_NAME[normalizedToolName];
    if (mapped) return pickVariation(mapped, seed ?? normalizedToolName);
    // Unknown / future orchestrator tool — keep it neutral instead of
    // leaking the raw tool identifier into the UI.
    return pickVariation(FALLBACK_VARIATIONS, seed ?? normalizedToolName);
  }

  if (isReasoning) return pickVariation(REASONING_VARIATIONS, seed);

  return pickVariation(IDLE_VARIATIONS, seed);
}
