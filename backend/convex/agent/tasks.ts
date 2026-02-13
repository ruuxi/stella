import {
  internalAction,
  internalMutation,
  internalQuery,
  ActionCtx,
} from "../_generated/server";
import { v, ConvexError, Infer, type Value } from "convex/values";
import { generateText } from "ai";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { buildSystemPrompt } from "./prompt_builder";
import { eventsToHistoryMessages } from "./history_messages";
import {
  computeCompactionTriggerTokens,
  SUBAGENT_HISTORY_MAX_TOKENS,
  TASK_DELIVERY_HISTORY_MAX_TOKENS,
} from "./context_budget";
import type { DeviceToolContext } from "./device_tools";
import { createTools } from "../tools/index";
import { resolveModelConfig } from "./model_resolver";
import { requireConversationOwner } from "../auth";

const taskValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  parentTaskId: v.optional(v.id("tasks")),
  description: v.string(),
  prompt: v.string(),
  agentType: v.string(),
  status: v.string(),
  taskDepth: v.number(),
  model: v.optional(v.string()),
  result: v.optional(v.string()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
});

// Task without model field for client responses
const taskClientValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  parentTaskId: v.optional(v.id("tasks")),
  description: v.string(),
  prompt: v.string(),
  agentType: v.string(),
  status: v.string(),
  taskDepth: v.number(),
  result: v.optional(v.string()),
  error: v.optional(v.string()),
  statusUpdates: v.optional(v.array(v.object({
    text: v.string(),
    timestamp: v.number(),
  }))),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
});

// Inferred type from validator for type-safe sanitization
type TaskClient = Infer<typeof taskClientValidator>;

const DEFAULT_MAX_TASK_DEPTH = 2;
const TASK_CANCEL_POLL_INTERVAL_MS = 2000;
const TASK_CHECKIN_INTERVAL_MS = 10 * 60 * 1000;
const PREFERRED_BROWSER_KEY = "preferred_browser";
const BROWSER_AGENT_SAFARI_DENIED_REASON =
  "Browser Agent is unavailable when the selected browser is Safari. Use a Chromium-based browser for browser automation.";

const isSafariBrowserPreference = (value: string | null): boolean =>
  value?.trim().toLowerCase() === "safari";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TaskStatus = "running" | "completed" | "error" | "canceled";

/** Strip model field for client responses */
const toTaskClient = (task: Record<string, unknown>): TaskClient => {
  const { model: _model, ...rest } = task;
  return rest as TaskClient;
};

/** Strip model field, returning null if task is null */
const toTaskClientOrNull = (task: Record<string, unknown> | null): TaskClient | null => {
  if (!task) return null;
  const { model: _model, ...rest } = task;
  return rest as TaskClient;
};

const appendTaskEvent = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    conversationId: Id<"conversations">;
    type: string;
    deviceId: string;
    payload: Record<string, Value | undefined>;
    targetDeviceId: string;
  },
): Promise<void> => {
  await ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: args.type,
    deviceId: args.deviceId,
    targetDeviceId: args.targetDeviceId,
    payload: args.payload,
  });
};

type RecallMemoryArgs = {
  query?: string;
  categories?: Array<{ category: string; subcategory: string }>;
};

type SubagentExecutionArgs = {
  conversationId: Id<"conversations">;
  userMessageId: Id<"events">;
  targetDeviceId: string;
  prompt: string;
  subagentType: string;
  taskId: Id<"tasks">;
  ownerId?: string;
  includeHistory?: boolean;
  historyMaxTokens?: number;
  threadId?: Id<"threads">;
  recallMemory?: RecallMemoryArgs;
  preExplore?: string;
  commandId?: string;
  overflowRecoveryAttempt?: number;
};

const buildHistoryMessages = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
  userMessageId: Id<"events">,
  maxTokens: number,
) => {
  const userEvent = await ctx.runQuery(internal.events.getById, { id: userMessageId });
  const historyEvents = await ctx.runQuery(internal.events.listRecentContextEventsByTokens, {
    conversationId,
    maxTokens,
    beforeTimestamp: userEvent?.timestamp,
    excludeEventId: userMessageId,
  });
  return eventsToHistoryMessages(historyEvents);
};

/** Pick a random entry from a list. */
const pick = (list: string[]): string => list[Math.floor(Math.random() * list.length)];

/** Classify a bash command into a high-level activity. */
const classifyBashCommand = (cmd: string): string => {
  const lower = cmd.toLowerCase();
  if (/\b(test|jest|vitest|mocha|pytest|cargo test|go test|spec)\b/.test(lower)) return "test";
  if (/\b(install|add|npm i|bun add|yarn add|pip install|cargo add)\b/.test(lower)) return "install";
  if (/\b(build|compile|tsc|webpack|vite build|cargo build|make)\b/.test(lower)) return "build";
  if (/\b(git\s+(log|diff|status|show|blame|stash|branch|checkout))\b/.test(lower)) return "git";
  if (/\b(git\s+(add|commit|push|pull|merge|rebase|cherry-pick))\b/.test(lower)) return "git-write";
  if (/\b(lint|eslint|prettier|format|clippy)\b/.test(lower)) return "lint";
  if (/\b(start|dev|serve|run dev|up)\b/.test(lower)) return "server";
  return "other";
};

const CONTEXT_OVERFLOW_RE =
  /(context length|context window|too many tokens|max(?:imum)? context|prompt(?:\s+is)? too long|token limit|context_length_exceeded)/i;

const isContextOverflowError = (message: string): boolean =>
  CONTEXT_OVERFLOW_RE.test(message);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const normalizeToolCallId = (value: string): string => {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
};

const asThreadMessageText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toStoredThreadEnvelope = (message: { role: string; content: unknown; toolCallId?: string }) =>
  JSON.stringify({
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  });

const replayThreadMessage = (message: { role: "user" | "assistant" | "tool"; content: string; toolCallId?: string }) => {
  const parsed = parseJson(message.content);
  const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { role?: string; content?: unknown; toolCallId?: string })
    : null;
  const payload = envelope?.content ?? parsed;
  const callId = message.toolCallId ?? envelope?.toolCallId;

  if (message.role === "assistant") {
    return {
      role: "assistant" as const,
      content: payload,
    };
  }

  if (message.role === "tool") {
    const prefix = callId ? `[Tool result ${callId}]` : "[Tool result]";
    return {
      role: "user" as const,
      content: `${prefix}\n${asThreadMessageText(payload)}`,
    };
  }

  return {
    role: "user" as const,
    content: typeof payload === "string" ? payload : asThreadMessageText(payload),
  };
};

const STATUS_DESCRIPTIONS: Record<string, string[]> = {
  Read: [
    "Taking a peek at the source",
    "Scanning through some files",
    "Reviewing the code",
    "Diving into the codebase",
    "Studying the source code",
    "Examining some files",
    "Going through the code",
    "Poking around the project",
    "Investigating the code",
    "Flipping through the source",
    "Browsing the codebase",
    "Getting familiar with the code",
    "Pulling up some files",
    "Skimming through the code",
    "Taking a closer look",
    "Checking out the details",
    "Leafing through the source",
    "Reading up on the code",
    "Peering into the files",
    "Looking over the implementation",
  ],
  Write: [
    "Writing some fresh code",
    "Creating a new file",
    "Putting together some code",
    "Crafting something new",
    "Spinning up a new file",
    "Drafting some code",
    "Whipping up something new",
    "Building from scratch",
    "Starting a new file",
    "Cooking up some code",
    "Laying down some new code",
    "Setting up something new",
    "Getting creative",
    "Bringing something new to life",
    "Sketching out a new file",
    "Composing some code",
    "Piecing together a new file",
    "Starting fresh on a file",
    "Planting a new seed in the project",
    "Drafting up something cool",
  ],
  Edit: [
    "Making some tweaks",
    "Fine-tuning the code",
    "Adjusting a few things",
    "Polishing the code",
    "Touching up some details",
    "Refining the implementation",
    "Making a few changes",
    "Updating the code",
    "Reworking some pieces",
    "Tightening things up",
    "Smoothing out the code",
    "Patching things up",
    "Tidying up the code",
    "Sprucing things up",
    "Ironing out the code",
    "Tweaking a few things",
    "Cleaning things up",
    "Working through some edits",
    "Putting the finishing touches on",
    "Giving the code a makeover",
  ],
  Glob: [
    "Searching through the project",
    "Hunting for the right files",
    "Looking around the codebase",
    "Tracking something down",
    "Digging through the project",
    "Scouting the codebase",
    "Finding what we need",
    "Scanning for matches",
    "Combing through the files",
    "On the hunt for files",
    "Locating the right spot",
    "Playing detective",
    "Narrowing things down",
    "Following the trail",
    "Zeroing in on the right files",
    "Sifting through the project",
    "Rummaging through the codebase",
    "Sniffing out the right files",
    "Scoping out the project",
    "Looking for the missing piece",
  ],
  Grep: [
    "Searching through the code",
    "Looking for a needle in the codebase",
    "Hunting for specific code",
    "Tracking down a reference",
    "Digging through the source",
    "Scanning the codebase",
    "Combing through the code",
    "Searching for a pattern",
    "Following the breadcrumbs",
    "Zeroing in on something",
    "Tracing through the code",
    "Looking for clues in the code",
    "Scouring the source",
    "Picking through the code",
    "Sniffing out a reference",
    "Doing some detective work",
    "Chasing down a lead",
    "Looking for the right spot",
    "Sleuthing through the codebase",
    "Finding the right lines",
  ],
  "Bash:test": [
    "Running the tests",
    "Making sure everything works",
    "Checking for any issues",
    "Putting the code through its paces",
    "Verifying everything's good",
    "Running a quick check",
    "Testing things out",
    "Double-checking the code",
    "Making sure nothing's broken",
    "Running some quality checks",
    "Kicking the tires",
    "Seeing if it all holds up",
    "Giving the code a test drive",
    "Sanity-checking the changes",
    "Validating the changes",
    "Making sure it's all good",
    "Checking our work",
    "Running diagnostics",
    "Seeing if the tests are happy",
    "Making sure everything's solid",
  ],
  "Bash:install": [
    "Installing dependencies",
    "Grabbing the packages we need",
    "Setting up dependencies",
    "Pulling in some libraries",
    "Getting everything installed",
    "Fetching the required packages",
    "Loading up dependencies",
    "Downloading what we need",
    "Bringing in the tools",
    "Setting things up",
    "Gathering the building blocks",
    "Getting the pieces in place",
    "Prepping the dependencies",
    "Rounding up the libraries",
    "Getting the ingredients ready",
    "Pulling in the essentials",
    "Lining up the dependencies",
    "Stocking up on packages",
    "Getting everything we need",
    "Wrangling some packages",
  ],
  "Bash:build": [
    "Building the project",
    "Compiling everything",
    "Putting it all together",
    "Assembling the build",
    "Bundling things up",
    "Packaging the project",
    "Getting the build ready",
    "Baking the build",
    "Firing up the compiler",
    "Wrapping it all up",
    "Stitching everything together",
    "Making it production-ready",
    "Turning code into magic",
    "Running the build pipeline",
    "Bringing it all together",
    "Crunching the code",
    "Forging the build",
    "Processing the code",
    "Generating the output",
    "Constructing the final product",
  ],
  "Bash:git": [
    "Checking version history",
    "Looking through the git log",
    "Reviewing the commit history",
    "Checking what's changed",
    "Going through the history",
    "Tracing the changes",
    "Looking at past work",
    "Checking the record",
    "Reviewing the project history",
    "Digging through commits",
    "Checking the paper trail",
    "Looking at the revision history",
    "Reviewing what happened",
    "Following the breadcrumbs",
    "Checking the project timeline",
    "Looking back at changes",
    "Investigating the history",
    "Peeking at the timeline",
    "Scanning the changelog",
    "Auditing past changes",
  ],
  "Bash:git-write": [
    "Saving the changes",
    "Committing the work",
    "Pushing things forward",
    "Recording the changes",
    "Locking in the updates",
    "Shipping the code",
    "Wrapping up the changes",
    "Sealing the deal",
    "Packaging up the work",
    "Making it official",
    "Checking in the code",
    "Saving our progress",
    "Preserving the changes",
    "Finalizing the updates",
    "Stamping the changes",
    "Buttoning up the work",
    "Putting a bow on it",
    "Logging the changes",
    "Marking a checkpoint",
    "Locking it in",
  ],
  "Bash:lint": [
    "Checking code quality",
    "Tidying up the formatting",
    "Running the linter",
    "Making sure the style is right",
    "Polishing the code style",
    "Enforcing code standards",
    "Cleaning up formatting",
    "Checking for style issues",
    "Giving the code a once-over",
    "Making things pretty",
    "Running a style check",
    "Ensuring consistency",
    "Straightening up the code",
    "Applying formatting rules",
    "Dotting the i's and crossing the t's",
    "Making the code presentable",
    "Grooming the codebase",
    "Running the style police",
    "Whipping the code into shape",
    "Aligning the formatting",
  ],
  "Bash:server": [
    "Starting the dev server",
    "Spinning up the server",
    "Getting the server going",
    "Booting up the dev environment",
    "Firing up the server",
    "Launching the dev server",
    "Bringing the server online",
    "Warming up the server",
    "Starting up the engine",
    "Getting things running",
    "Powering up the dev environment",
    "Lighting up the server",
    "Kickstarting the server",
    "Opening shop",
    "Turning the key",
    "Revving up the server",
    "Setting the stage",
    "Booting up",
    "Starting the engines",
    "Getting the show on the road",
  ],
  "Bash:other": [
    "Running a command",
    "Doing some behind-the-scenes work",
    "Working in the terminal",
    "Taking care of something",
    "Handling some setup",
    "Running a quick operation",
    "Getting something done",
    "Doing a little housekeeping",
    "Working some magic",
    "Tinkering under the hood",
    "Taking care of business",
    "Running something real quick",
    "Handling the details",
    "Working through the details",
    "Doing the heavy lifting",
    "Making things happen",
    "Processing in the background",
    "Crunching away",
    "Wrapping up a quick task",
    "Keeping the gears turning",
  ],
  WebSearch: [
    "Searching the web",
    "Looking it up online",
    "Doing some research",
    "Consulting the internet",
    "Finding some answers online",
    "Browsing for information",
    "Scouring the web",
    "Looking for answers online",
    "Doing a quick search",
    "Researching the topic",
    "Checking the web",
    "Gathering some intel",
    "Looking into it online",
    "Tracking down info online",
    "Checking the latest online",
    "Digging into the web",
    "Asking the internet",
    "Surfing for answers",
    "Going online for info",
    "Hitting up the search engines",
  ],
  WebFetch: [
    "Grabbing some info from a page",
    "Checking out a webpage",
    "Pulling up a reference",
    "Reading an online resource",
    "Fetching some documentation",
    "Looking at a web page",
    "Pulling some info from the web",
    "Checking a reference online",
    "Loading up a resource",
    "Consulting an online source",
    "Reviewing a web page",
    "Peeking at a web page",
    "Getting info from a site",
    "Checking the docs online",
    "Reading up on something",
    "Visiting a resource",
    "Referencing an online page",
    "Browsing a resource",
    "Grabbing a reference",
    "Pulling data from a page",
  ],
  StoreSearch: [
    "Browsing the store",
    "Looking through the marketplace",
    "Checking what's available",
    "Shopping for add-ons",
    "Searching the catalog",
    "Exploring the store",
    "Seeing what's out there",
    "Window shopping",
    "Hunting for the perfect add-on",
    "Checking the shelves",
    "Looking for something cool",
    "Scanning the store",
    "Perusing the catalog",
    "Seeing what we can find",
    "Shopping around",
    "Checking out the options",
    "Digging through the store",
    "Scouting the marketplace",
    "Looking for the right fit",
    "Browsing the marketplace",
  ],
  OpenCanvas: [
    "Preparing something visual",
    "Setting up a display",
    "Getting ready to show you something",
    "Putting together a visual",
    "Firing up the canvas",
    "Creating something to show you",
    "Setting the stage",
    "Preparing a preview",
    "Getting the visual ready",
    "Spinning up a display",
    "Building something visual",
    "Laying out a display",
    "Setting up the canvas",
    "Crafting a visual",
    "Prepping a preview",
    "Getting things ready to display",
    "Working on a visual",
    "Assembling a display",
    "Whipping up something visual",
    "Putting on a show",
  ],
  default: [
    "Working on it...",
    "Making progress...",
    "Chugging along...",
    "Busy at work...",
    "Getting things done...",
    "On it...",
    "In the zone...",
    "Plugging away...",
    "Working behind the scenes...",
    "Making things happen...",
    "Keeping busy...",
    "Moving forward...",
    "Hard at work...",
    "Cooking something up...",
    "Taking care of things...",
    "Hammering away...",
    "Working the magic...",
    "Staying focused...",
    "Grinding away...",
    "Getting closer...",
  ],
};

/** Map a tool call to a friendly, non-technical description for progress tracking. */
const describeToolCall = (toolName: string, _args: Record<string, unknown>): string => {
  // Direct tool match
  if (STATUS_DESCRIPTIONS[toolName]) {
    return pick(STATUS_DESCRIPTIONS[toolName]);
  }

  // Bash commands get sub-classified
  if (toolName === "Bash") {
    const cmd = typeof _args.command === "string" ? _args.command : "";
    const category = classifyBashCommand(cmd);
    const key = `Bash:${category}`;
    return pick(STATUS_DESCRIPTIONS[key] ?? STATUS_DESCRIPTIONS["Bash:other"]);
  }

  // CloseCanvas is rare and boring — just skip it
  if (toolName === "CloseCanvas") return "Tidying up";

  // TaskCreate — keep the description if present, it's already human-written
  if (toolName === "TaskCreate") {
    return typeof _args.description === "string" ? _args.description : "Delegating some work";
  }

  return pick(STATUS_DESCRIPTIONS.default);
};

const executeSubagentRun = async (
  ctx: ActionCtx,
  args: SubagentExecutionArgs,
): Promise<string> => {
  const currentStatus = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
    taskId: args.taskId,
  });
  if (currentStatus && currentStatus !== "running") {
    return `Task ${currentStatus}.\nTask ID: ${args.taskId}`;
  }

  const promptBuild = await buildSystemPrompt(ctx, args.subagentType, {
    ownerId: args.ownerId,
  });

  let effectiveAllowlist = promptBuild.toolsAllowlist
    ? [...promptBuild.toolsAllowlist]
    : undefined;
  let effectiveSystemPrompt = promptBuild.systemPrompt;

  const historyTokenBudget = args.historyMaxTokens ?? SUBAGENT_HISTORY_MAX_TOKENS;
  const historyMessages = args.includeHistory
      ? await buildHistoryMessages(
          ctx,
          args.conversationId,
          args.userMessageId,
          historyTokenBudget,
        )
      : [];

  // --- Thread loading ---
  const threadSupported = args.subagentType === "general" || args.subagentType === "self_mod";
  let threadMessages: Array<{ role: "user" | "assistant" | "tool"; content: string; toolCallId?: string }> = [];
  let summaryPair: Array<{ role: "user" | "assistant"; content: string }> = [];

  if (args.threadId && threadSupported) {
    try {
      await ctx.runMutation(internal.data.threads.touchThread, {
        threadId: args.threadId,
      });

      const thread = await ctx.runQuery(internal.data.threads.getThreadById, {
        threadId: args.threadId,
      });

      // Inject summary as synthetic user/assistant pair
      if (thread?.summary) {
        summaryPair = [
          { role: "user" as const, content: `[Thread context — prior work summary]\n${thread.summary}` },
          { role: "assistant" as const, content: "Understood. I have the context from previous work." },
        ];
      }

      // Load thread messages and deserialize
      const rawMessages = await ctx.runQuery(internal.data.threads.loadThreadMessages, {
        threadId: args.threadId,
      });

      threadMessages = rawMessages.map((m) => ({
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      }));
    } catch {
      // Thread loading failed — proceed without thread context
    }
  }

  const toolContext: DeviceToolContext = {
    conversationId: args.conversationId,
    userMessageId: args.userMessageId,
    targetDeviceId: args.targetDeviceId,
    agentType: args.subagentType,
    sourceDeviceId: args.targetDeviceId,
    currentTaskId: args.taskId,
  };

  let finished = false;
  let canceled = false;
  const abortController = new AbortController();

  const cancelWatcher = (async () => {
    while (!finished) {
      await sleep(TASK_CANCEL_POLL_INTERVAL_MS);
      if (finished) {
        return;
      }
      const status = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
        taskId: args.taskId,
      });
      if (status === "canceled") {
        canceled = true;
        abortController.abort();
        return;
      }
      if (status && status !== "running") {
        return;
      }
    }
  })();

  try {
    const resolvedConfig = await resolveModelConfig(ctx, args.subagentType, args.ownerId);

    // --- Pre-gathered context (memory recall + explore) ---
    const preGatheredParts: string[] = [];

    if (args.recallMemory && args.ownerId) {
      try {
        const query = args.recallMemory.query || args.prompt.slice(0, 500);
        let categories = args.recallMemory.categories;
        if (!categories || categories.length === 0) {
          const allCats = await ctx.runQuery(internal.data.memory.listCategories, {
            ownerId: args.ownerId,
          });
          categories = allCats.map((c: { category: string; subcategory: string }) => ({
            category: c.category,
            subcategory: c.subcategory,
          }));
        }
        if (categories.length > 0) {
          const memoryResult = await ctx.runAction(internal.data.memory.recallMemories, {
            ownerId: args.ownerId,
            categories,
            query,
          });
          if (memoryResult && memoryResult !== "No memories found for the requested categories.") {
            preGatheredParts.push(`## Recalled Memories\n${memoryResult}`);
          }
        }
      } catch (e) {
        console.error("Pre-gather memory recall failed:", (e as Error).message);
      }
    }

    if (args.preExplore && args.ownerId) {
      try {
        const explorePromptBuild = await buildSystemPrompt(ctx, "explore", {
          ownerId: args.ownerId,
        });
        const exploreModelConfig = await resolveModelConfig(ctx, "explore", args.ownerId);
        const exploreTools = createTools(ctx, toolContext, {
          agentType: "explore",
          toolsAllowlist: explorePromptBuild.toolsAllowlist,
          maxTaskDepth: 0,
          ownerId: args.ownerId,
          conversationId: args.conversationId,
        });
        const exploreResult = await generateText({
          ...exploreModelConfig,
          system: explorePromptBuild.systemPrompt,
          tools: exploreTools,
          messages: [{ role: "user" as const, content: args.preExplore }],
        });
        const exploreText = exploreResult.text?.trim() ?? "";
        if (exploreText) {
          preGatheredParts.push(`## Explore Results\n${exploreText}`);
        }
      } catch (e) {
        console.error("Pre-gather explore failed:", (e as Error).message);
      }
    }

    // Build the messages array: summary → thread history → conversation history → new prompt
    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];

    for (const sp of summaryPair) {
      if (sp.role === "assistant") {
        messages.push({ role: "assistant", content: sp.content });
      } else {
        messages.push({ role: "user", content: sp.content });
      }
    }
    for (const tm of threadMessages) {
      messages.push(replayThreadMessage(tm));
    }
    for (const hm of historyMessages) {
      if (hm.role === "assistant") {
        messages.push({ role: "assistant", content: hm.content });
      } else {
        messages.push({ role: "user", content: hm.content });
      }
    }
    const promptContent: Array<{ type: "text"; text: string }> = [];
    if (preGatheredParts.length > 0) {
      promptContent.push({
        type: "text" as const,
        text: `<context>\n${preGatheredParts.join("\n\n")}\n</context>\n\n`,
      });
    }
    promptContent.push({ type: "text" as const, text: args.prompt.trim() || " " });
    if (args.commandId) {
      try {
        const command = await ctx.runQuery(
          internal.data.commands.getByCommandId,
          { commandId: args.commandId },
        );
        if (command) {
          promptContent.push({
            type: "text" as const,
            text: `\n\n<command-instructions name="${command.name}">\n${command.content}\n</command-instructions>`,
          });
        }
      } catch {
        // Command lookup failed — proceed without instructions
      }
    }
    if (promptBuild.dynamicContext) {
      promptContent.push({
        type: "text" as const,
        text: `\n\n<system-context>\n${promptBuild.dynamicContext}\n</system-context>`,
      });
    }
    messages.push({ role: "user" as const, content: promptContent });

    const result = await generateText({
      ...resolvedConfig,
      system: effectiveSystemPrompt,
      tools: createTools(
        ctx,
        toolContext,
        {
          agentType: args.subagentType,
          toolsAllowlist: effectiveAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          ownerId: args.ownerId,
          currentTaskId: args.taskId,
          conversationId: args.conversationId,
        },
      ),
      messages: messages as any[],
      abortSignal: abortController.signal,
      onStepFinish: async ({ toolCalls }) => {
        if (!toolCalls || toolCalls.length === 0) return;
        const descriptions = toolCalls.map(
          (tc) => describeToolCall(
            tc.toolName,
            "args" in tc && tc.args ? (tc.args as Record<string, unknown>) : {},
          ),
        );
        for (const desc of descriptions) {
          try {
            await ctx.runMutation(internal.agent.tasks.pushStatusUpdate, {
              taskId: args.taskId,
              text: desc,
            });
          } catch {
            // Task may have been canceled — ignore
          }
        }
      },
    });

    const text: string = result.text ?? "";
    finished = true;
    await cancelWatcher;

    const postStatus = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (postStatus && postStatus !== "running") {
      return `Task ${postStatus}.\nTask ID: ${args.taskId}`;
    }

    // --- Thread saving (only on success) ---
    if (args.threadId && threadSupported) {
      try {
        // Save the task prompt as a user message
        const messagesToSave: Array<{
          role: string;
          content: string;
          toolCallId?: string;
          tokenEstimate?: number;
        }> = [
          {
            role: "user",
            content: args.prompt,
          },
        ];

        // Save all response messages from the result
        if (result.response?.messages) {
          for (const msg of result.response.messages) {
            const rawToolCallId =
              (msg as { toolCallId?: unknown }).toolCallId;
            const toolCallId =
              typeof rawToolCallId === "string"
                ? normalizeToolCallId(rawToolCallId)
                : undefined;
            messagesToSave.push({
              role: msg.role,
              content: toStoredThreadEnvelope({
                role: msg.role,
                content: msg.content,
                toolCallId,
              }),
              ...(toolCallId ? { toolCallId } : {}),
            });
          }
        }

        await ctx.runMutation(internal.data.threads.saveThreadMessages, {
          threadId: args.threadId,
          messages: messagesToSave,
        });

        // Check if compaction is needed using token-pressure thresholds.
        const inputTokens = result.usage?.inputTokens ?? 0;
        const updatedThread = await ctx.runQuery(internal.data.threads.getThreadById, {
          threadId: args.threadId,
        });
        const threadTokens = updatedThread?.totalTokenEstimate ?? 0;
        const compactionTriggerTokens = computeCompactionTriggerTokens(
          typeof resolvedConfig.model === "string" ? resolvedConfig.model : undefined,
        );
        if (
          inputTokens > compactionTriggerTokens ||
          threadTokens > compactionTriggerTokens
        ) {
          await ctx.scheduler.runAfter(0, internal.data.threads.compactThread, {
            threadId: args.threadId,
          });
        }
      } catch {
        // Thread saving failed — don't fail the task
      }
    }

    await ctx.runMutation(internal.agent.tasks.completeTaskRecord, {
      taskId: args.taskId,
      status: "completed",
      result: text,
    });

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_completed",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId: args.taskId,
        result: text,
      },
    });

    return `Agent completed.\nTask ID: ${args.taskId}\n\n--- Agent Result ---\n${text}`;
  } catch (error) {
    finished = true;
    await cancelWatcher;

    const status = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (canceled || status === "canceled") {
      return `Task canceled.\nTask ID: ${args.taskId}`;
    }

    const errorMessage = (error as Error).message || "Unknown task error";

    const overflowRecoveryAttempt = args.overflowRecoveryAttempt ?? 0;
    if (isContextOverflowError(errorMessage) && overflowRecoveryAttempt < 1) {
      try {
        await ctx.runMutation(internal.agent.tasks.pushStatusUpdate, {
          taskId: args.taskId,
          text: "Context limit reached, compacting and retrying",
        });
      } catch {
        // Ignore status update errors.
      }

      if (args.threadId && threadSupported) {
        try {
          await ctx.runAction(internal.data.threads.compactThread, {
            threadId: args.threadId,
          });
        } catch {
          // Best effort; continue retry even if compaction fails.
        }
      }

      const nextHistoryMaxTokens = args.includeHistory
        ? Math.max(4_000, Math.floor(historyTokenBudget / 2))
        : undefined;

      return await executeSubagentRun(ctx, {
        ...args,
        overflowRecoveryAttempt: overflowRecoveryAttempt + 1,
        historyMaxTokens: nextHistoryMaxTokens,
      });
    }

    await ctx.runMutation(internal.agent.tasks.completeTaskRecord, {
      taskId: args.taskId,
      status: "error",
      error: errorMessage,
    });

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_failed",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId: args.taskId,
        error: errorMessage,
      },
    });

    return `Task failed.\nTask ID: ${args.taskId}\n\n--- Error ---\n${errorMessage}`;
  }
};

export const createTaskRecord = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    description: v.string(),
    prompt: v.string(),
    agentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    maxTaskDepth: v.optional(v.number()),
  },
  returns: v.object({
    taskId: v.id("tasks"),
    taskDepth: v.number(),
    maxTaskDepth: v.number(),
  }),
  handler: async (ctx, args) => {
    const maxTaskDepth = Math.max(1, Math.floor(args.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH));

    let taskDepth = 1;
    if (args.parentTaskId) {
      const parent = await ctx.db.get(args.parentTaskId);
      if (parent?.taskDepth) {
        taskDepth = parent.taskDepth + 1;
      }
      if (taskDepth > maxTaskDepth) {
        throw new ConvexError({ code: "LIMIT_EXCEEDED", message: `Task depth limit exceeded (${maxTaskDepth})` });
      }
    }

    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      conversationId: args.conversationId,
      parentTaskId: args.parentTaskId,
      description: args.description,
      prompt: args.prompt,
      agentType: args.agentType,
      status: "running" satisfies TaskStatus,
      taskDepth,
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
    });

    return { taskId, taskDepth, maxTaskDepth };
  },
});

export const completeTaskRecord = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: v.string(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: args.status,
      result: args.result,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });
    const record = await ctx.db.get(args.taskId);
    return toTaskClientOrNull(record);
  },
});

const MAX_STATUS_UPDATES = 5;

export const pushStatusUpdate = internalMutation({
  args: {
    taskId: v.id("tasks"),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.status !== "running") return null;

    const updates = task.statusUpdates ?? [];
    const lastText = updates.length > 0 ? updates[updates.length - 1].text : "";

    // Skip if identical to the previous update
    if (args.text === lastText) return null;

    updates.push({ text: args.text, timestamp: Date.now() });

    // Keep only the most recent entries
    const trimmed = updates.length > MAX_STATUS_UPDATES
      ? updates.slice(updates.length - MAX_STATUS_UPDATES)
      : updates;

    await ctx.db.patch(args.taskId, {
      statusUpdates: trimmed,
      updatedAt: Date.now(),
    });

    // Emit a lightweight event so the frontend can pick up progress
    await ctx.db.insert("events", {
      conversationId: task.conversationId,
      type: "task_progress",
      payload: {
        taskId: args.taskId as string,
        statusText: args.text,
      },
      timestamp: Date.now(),
    });

    return null;
  },
});

export const cancelTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    reason: v.optional(v.string()),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;
    await requireConversationOwner(ctx, record.conversationId);

    if (record.status !== "running") {
      return toTaskClient(record);
    }

    const now = Date.now();
    const reason = args.reason?.trim() || "Canceled";
    await ctx.db.patch(args.taskId, {
      status: "canceled" satisfies TaskStatus,
      error: reason,
      updatedAt: now,
      completedAt: now,
    });

    const targetDeviceId = await ctx.runQuery(internal.events.getLatestDeviceIdForConversation, {
      conversationId: record.conversationId,
    });

    if (targetDeviceId) {
      await appendTaskEvent(ctx, {
        conversationId: record.conversationId,
        type: "task_failed",
        deviceId: targetDeviceId,
        targetDeviceId: targetDeviceId,
        payload: {
          taskId: args.taskId,
          error: reason,
        },
      });
    }

    const updated = await ctx.db.get(args.taskId);
    return toTaskClientOrNull(updated);
  },
});

export const cancelTaskInternal = internalMutation({
  args: {
    taskId: v.id("tasks"),
    reason: v.optional(v.string()),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;

    if (record.status !== "running") {
      return toTaskClient(record);
    }

    const now = Date.now();
    const reason = args.reason?.trim() || "Canceled";
    await ctx.db.patch(args.taskId, {
      status: "canceled" satisfies TaskStatus,
      error: reason,
      updatedAt: now,
      completedAt: now,
    });

    const targetDeviceId = await ctx.runQuery(internal.events.getLatestDeviceIdForConversation, {
      conversationId: record.conversationId,
    });

    if (targetDeviceId) {
      await appendTaskEvent(ctx, {
        conversationId: record.conversationId,
        type: "task_failed",
        deviceId: targetDeviceId,
        targetDeviceId: targetDeviceId,
        payload: {
          taskId: args.taskId,
          error: reason,
        },
      });
    }

    const updated = await ctx.db.get(args.taskId);
    return toTaskClientOrNull(updated);
  },
});

export const getTaskStatus = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    return record?.status ?? null;
  },
});

export const getById = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (record) {
      await requireConversationOwner(ctx, record.conversationId);
    }
    return toTaskClientOrNull(record);
  },
});

export const getOutputByExternalId = internalQuery({
  args: {
    taskId: v.string(),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    try {
      const record = await ctx.db.get(args.taskId as Id<"tasks">);
      if (record) {
        await requireConversationOwner(ctx, record.conversationId);
      }
      return toTaskClientOrNull(record);
    } catch {
      return null;
    }
  },
});

export const getOutputByExternalIdInternal = internalQuery({
  args: {
    taskId: v.string(),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    try {
      const record = await ctx.db.get(args.taskId as Id<"tasks">);
      return toTaskClientOrNull(record);
    } catch {
      return null;
    }
  },
});

export const listByConversation = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.array(taskClientValidator),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const records = await ctx.db
      .query("tasks")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(200);
    return records.map((record) => toTaskClient(record));
  },
});

export const listByConversationSince = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    afterUpdatedAt: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(taskClientValidator),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);

    const afterUpdatedAt = args.afterUpdatedAt ?? 0;
    const requestedLimit = args.limit ?? 200;
    const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), 1000);
    const records = await ctx.db
      .query("tasks")
      .withIndex("by_conversation_updated", (q) =>
        q.eq("conversationId", args.conversationId).gt("updatedAt", afterUpdatedAt),
      )
      .order("asc")
      .take(limit);

    return records.map((record) => toTaskClient(record));
  },
});

export const getConversationTaskHead = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.object({
    latestUpdatedAt: v.number(),
    latestTaskId: v.union(v.id("tasks"), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const latest = await ctx.db
      .query("tasks")
      .withIndex("by_conversation_updated", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();

    return {
      latestUpdatedAt: latest?.updatedAt ?? 0,
      latestTaskId: latest?._id ?? null,
    };
  },
});

export const runSubagent = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    description: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    includeHistory: v.optional(v.boolean()),
    threadId: v.optional(v.string()),
    threadName: v.optional(v.string()),
    recallMemory: v.optional(v.object({
      query: v.optional(v.string()),
      categories: v.optional(v.array(v.object({
        category: v.string(),
        subcategory: v.string(),
      }))),
    })),
    preExplore: v.optional(v.string()),
    commandId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const conversation: Doc<"conversations"> = await requireConversationOwner(ctx, args.conversationId);

    if (args.subagentType === "browser") {
      const preferredBrowser = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
        ownerId: conversation.ownerId,
        key: PREFERRED_BROWSER_KEY,
      });
      if (isSafariBrowserPreference(preferredBrowser)) {
        return `Task denied.\nReason: ${BROWSER_AGENT_SAFARI_DENIED_REASON}`;
      }
    }

    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
    await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});

    const promptBuild = await buildSystemPrompt(ctx, args.subagentType, {
      ownerId: conversation.ownerId,
    });

    // Resolve thread: threadId takes priority, then threadName lookup/create
    const threadSupported = args.subagentType === "general" || args.subagentType === "self_mod";
    let resolvedThreadId: Id<"threads"> | undefined;

    if (threadSupported) {
      if (args.threadId) {
        // Verify thread exists and reactivate if it was idle/archived.
        const activated = await ctx.runMutation(internal.data.threads.activateThread, {
          threadId: args.threadId as Id<"threads">,
        });
        if (activated) {
          resolvedThreadId = activated._id;
        }
        // If thread not found, proceed without thread context.
      } else if (args.threadName) {
        // Look up existing thread by name and reactivate it, or create new one.
        const existing = await ctx.runQuery(internal.data.threads.getThreadByName, {
          conversationId: args.conversationId,
          name: args.threadName,
        });
        if (existing) {
          const activated = await ctx.runMutation(internal.data.threads.activateThread, {
            threadId: existing._id,
          });
          resolvedThreadId = activated?._id;
        } else {
          resolvedThreadId = await ctx.runMutation(internal.data.threads.createThread, {
            conversationId: args.conversationId,
            name: args.threadName,
          });
        }
      }
    }

    const created: { taskId: Id<"tasks">; taskDepth: number; maxTaskDepth: number } =
      await ctx.runMutation(internal.agent.tasks.createTaskRecord, {
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
        description: args.description,
        prompt: args.prompt,
        agentType: args.subagentType,
        parentTaskId: args.parentTaskId,
        maxTaskDepth: promptBuild.maxTaskDepth,
      });

    const taskId: Id<"tasks"> = created.taskId;
    const taskDepth: number = created.taskDepth;

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_started",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId,
        description: args.description,
        agentType: args.subagentType,
        parentTaskId: args.parentTaskId,
        taskDepth,
        maxTaskDepth: created.maxTaskDepth,
        skillIds: promptBuild.skillIds,
      },
    });

    await ctx.scheduler.runAfter(TASK_CHECKIN_INTERVAL_MS, internal.agent.tasks.taskCheckin, {
      conversationId: args.conversationId,
      targetDeviceId: args.targetDeviceId,
      taskId,
    });

    await ctx.scheduler.runAfter(0, internal.agent.tasks.executeSubagent, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagentType,
      taskId,
      ownerId: conversation.ownerId,
      includeHistory: args.includeHistory,
      parentTaskId: args.parentTaskId,
      threadId: resolvedThreadId,
      recallMemory: args.recallMemory,
      preExplore: args.preExplore,
      commandId: args.commandId,
    });

    return `Task running.\nTask ID: ${taskId}\nElapsed: 0ms`;
  },
});

export const executeSubagent = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    description: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    taskId: v.id("tasks"),
    ownerId: v.string(),
    includeHistory: v.optional(v.boolean()),
    parentTaskId: v.optional(v.id("tasks")),
    threadId: v.optional(v.id("threads")),
    recallMemory: v.optional(v.object({
      query: v.optional(v.string()),
      categories: v.optional(v.array(v.object({
        category: v.string(),
        subcategory: v.string(),
      }))),
    })),
    preExplore: v.optional(v.string()),
    commandId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const resultText = await executeSubagentRun(ctx, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      prompt: args.prompt,
      subagentType: args.subagentType,
      taskId: args.taskId,
      ownerId: args.ownerId,
      includeHistory: args.includeHistory,
      threadId: args.threadId,
      recallMemory: args.recallMemory,
      preExplore: args.preExplore,
      commandId: args.commandId,
    });

    // Deliver result to the orchestrator for top-level tasks only.
    // Nested subagent results flow back through their parent's tool output.
    if (!args.parentTaskId) {
      const task = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
        taskId: args.taskId,
      });
      const status = task === "completed" ? "completed" : task === "error" ? "error" : task ?? "completed";

      // Extract the actual result text from the formatted return string
      const resultMatch = resultText.match(/--- (?:Agent Result|Error) ---\n([\s\S]*)$/);
      const cleanResult = resultMatch?.[1]?.trim() ?? resultText;

      await ctx.scheduler.runAfter(0, internal.agent.tasks.deliverTaskResult, {
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
        taskId: args.taskId,
        description: args.description,
        agentType: args.subagentType,
        result: cleanResult,
        status,
        ownerId: args.ownerId,
      });
    }

    return null;
  },
});

export const taskCheckin = internalAction({
  args: {
    conversationId: v.id("conversations"),
    targetDeviceId: v.string(),
    taskId: v.id("tasks"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const status = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (!status || status !== "running") {
      return null;
    }

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_checkin",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId: args.taskId,
        status,
      },
    });

    await ctx.scheduler.runAfter(TASK_CHECKIN_INTERVAL_MS, internal.agent.tasks.taskCheckin, {
      conversationId: args.conversationId,
      targetDeviceId: args.targetDeviceId,
      taskId: args.taskId,
    });
    return null;
  },
});

/**
 * Deliver a completed subagent's result to the orchestrator.
 *
 * When a top-level subagent finishes, this action re-invokes the orchestrator
 * with the task result as a user-role message. The orchestrator decides how
 * (or whether) to respond to the user. Its response is saved as an
 * assistant_message event so the frontend picks it up automatically.
 */
export const deliverTaskResult = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    taskId: v.id("tasks"),
    description: v.string(),
    agentType: v.string(),
    result: v.string(),
    status: v.string(),
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Build the internal message that the orchestrator will see
    const statusLabel = args.status === "completed" ? "completed" : "failed";
    const deliveryMessage = [
      `[System: Subagent task ${statusLabel}]`,
      `Task ID: ${args.taskId}`,
      `Agent: ${args.agentType}`,
      `Description: ${args.description}`,
      "",
      `--- ${args.status === "completed" ? "Result" : "Error"} ---`,
      args.result,
    ].join("\n");

    // Build orchestrator prompt and tools
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: args.conversationId,
    });
    if (!conversation) return null;

    const promptBuild = await buildSystemPrompt(ctx, "orchestrator", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
    });

    const toolContext: DeviceToolContext = {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      agentType: "orchestrator",
      sourceDeviceId: args.targetDeviceId,
    };

    const resolvedConfig = await resolveModelConfig(
      ctx,
      "orchestrator",
      args.ownerId,
    );

    try {
      let historyBudget = TASK_DELIVERY_HISTORY_MAX_TOKENS;
      for (let attempt = 0; attempt < 2; attempt++) {
        const historyEvents = await ctx.runQuery(
          internal.events.listRecentContextEventsByTokens,
          {
            conversationId: args.conversationId,
            maxTokens: historyBudget,
          },
        );
        const historyMessages = eventsToHistoryMessages(historyEvents);

        try {
          const genResult = await generateText({
            ...resolvedConfig,
            system: promptBuild.systemPrompt,
            tools: createTools(ctx, toolContext, {
              agentType: "orchestrator",
              toolsAllowlist: promptBuild.toolsAllowlist,
              maxTaskDepth: promptBuild.maxTaskDepth,
              ownerId: args.ownerId,
              conversationId: args.conversationId,
            }),
            messages: [
              ...historyMessages,
              {
                role: "user",
                content: promptBuild.dynamicContext
                  ? `${deliveryMessage}\n\n<system-context>\n${promptBuild.dynamicContext}\n</system-context>`
                  : deliveryMessage,
              },
            ],
          });

          // Check if NoResponse was called in any step
          const noResponseCalled = genResult.steps?.some(
            (step: { toolCalls?: Array<{ toolName: string }> }) =>
              step.toolCalls?.some((tc) => tc.toolName === "NoResponse"),
          );

          const text = genResult.text?.trim() ?? "";
          if (text.length > 0 && !noResponseCalled) {
            await ctx.runMutation(internal.events.saveAssistantMessage, {
              conversationId: args.conversationId,
              text,
              userMessageId: args.userMessageId,
              usage: genResult.usage
                ? {
                    inputTokens: genResult.usage.inputTokens,
                    outputTokens: genResult.usage.outputTokens,
                    totalTokens: genResult.usage.totalTokens,
                  }
                : undefined,
            });

            // Best-effort command suggestions after delivery.
            try {
              await ctx.scheduler.runAfter(0, internal.agent.suggestions.generateSuggestions, {
                conversationId: args.conversationId,
                ownerId: args.ownerId,
              });
            } catch { /* best-effort */ }
          }
          break;
        } catch (error) {
          const message = (error as Error).message ?? "Unknown error";
          if (attempt === 0 && isContextOverflowError(message)) {
            historyBudget = Math.max(4_000, Math.floor(historyBudget / 2));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      console.error("deliverTaskResult failed:", (error as Error).message);
    }

    return null;
  },
});



