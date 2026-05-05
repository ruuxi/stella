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
 * `spawn_agent`, `send_input`, `pause_agent` orchestrate other agents
 * under the hood. Those tools just get generic "Stella is doing the
 * work" copy.
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
  memory: [
    "Remembering",
    "Checking my memory",
    "Pulling up what I know",
    "Jogging my memory",
    "Looking back",
    "Recalling",
    "Thinking back",
    "Checking my notes",
    "Pulling from memory",
    "Casting my mind back",
  ],
  askquestion: [
    "One quick question",
    "Quick question",
    "Just a quick check",
    "Need to ask you something",
    "One sec",
    "Got something to ask",
    "Quick check with you",
    "Putting some options together",
    "One thing to confirm",
    "Want to double-check something",
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
};

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
    const normalizedToolName = toolName.toLowerCase();
    const mapped = TOOL_STATUS_BY_NAME[normalizedToolName];
    if (mapped) return pickVariation(mapped, seed ?? normalizedToolName);
    // Unknown / future orchestrator tool — keep it neutral instead of
    // leaking the raw tool identifier into the UI.
    return pickVariation(FALLBACK_VARIATIONS, seed ?? normalizedToolName);
  }

  if (isReasoning) return pickVariation(REASONING_VARIATIONS, seed);

  return pickVariation(IDLE_VARIATIONS, seed);
}
