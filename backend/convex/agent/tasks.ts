import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
  ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { v, ConvexError, Infer, type Value } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { buildSystemPrompt } from "./prompt_builder";
import {
  prepareOrchestratorTurn,
  toUsageSummary,
} from "./orchestrator_turn";
import {
  isAutoCompactionEnabled,
  ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS,
  TASK_DELIVERY_HISTORY_MAX_TOKENS,
  SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS,
  SUBAGENT_THREAD_HISTORY_MAX_TOKENS,
} from "./context_budget";
import type { DeviceToolContext } from "./device_tools";
import { createTools } from "../tools/index";
import { resolveModelConfig, resolveFallbackConfig } from "./model_resolver";
import {
  generateTextWithFailover,
  hasNoResponseInSteps,
} from "./model_execution";
import { requireConversationOwner, requireConversationOwnerAction } from "../auth";
import { normalizeOptionalInt } from "../lib/number_utils";
import { isContextOverflowError } from "@stella/shared";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { PREFERRED_BROWSER_KEY } from "../data/preferences";
import { BROWSER_AGENT_SAFARI_DENIED_REASON, SUBAGENT_TYPES } from "../lib/agent_constants";
import { sleep } from "../lib/async";

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
  deliveryCompletedAt: v.optional(v.number()),
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
const PERSIST_CHUNK_DEDUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERY_RETRY_BACKOFF_MS = 5_000;
const MAX_PERSIST_CHUNK_PAYLOAD_BYTES = 1_000_000;
const MAX_SYNC_TASKS_QUERY_LIMIT = 1000;
const ALLOWED_SUBAGENT_TYPES: Set<string> = new Set(SUBAGENT_TYPES);

const usageSummaryValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
});

const isSafariBrowserPreference = (value: string | null): boolean =>
  value?.trim().toLowerCase() === "safari";

type TaskStatus = "running" | "completed" | "error" | "canceled";
type RuntimeFinalTaskStatus = Exclude<TaskStatus, "running">;
const runtimeFinalTaskStatusValidator = v.union(
  v.literal("completed"),
  v.literal("error"),
  v.literal("canceled"),
);

const isTaskTerminalStatus = (status: string): status is RuntimeFinalTaskStatus =>
  status === "completed" || status === "error" || status === "canceled";

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

const applyTaskCancellation = async (
  ctx: MutationCtx,
  args: {
    taskId: Id<"tasks">;
    reason?: string;
  },
): Promise<TaskClient | null> => {
  const current = await ctx.db.get(args.taskId);
  if (!current) {
    return null;
  }
  if (current.status !== "running") {
    return toTaskClient(current);
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
    conversationId: current.conversationId,
  });
  if (targetDeviceId) {
    await appendTaskEvent(ctx, {
      conversationId: current.conversationId,
      type: "task_failed",
      deviceId: targetDeviceId,
      targetDeviceId,
      payload: {
        taskId: args.taskId,
        error: reason,
      },
    });
  }

  const updated = await ctx.db.get(args.taskId);
  return toTaskClientOrNull(updated);
};

const loadTaskByExternalTaskId = async (
  ctx: QueryCtx,
  taskId: string,
): Promise<Doc<"tasks"> | null> => {
  try {
    return await ctx.db.get(taskId as Id<"tasks">);
  } catch {
    // Invalid external task ID — return null to indicate not found
    return null;
  }
};

const appendTaskEvent = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    conversationId: Id<"conversations">;
    type: string;
    deviceId?: string;
    payload: Record<string, Value | undefined>;
    targetDeviceId?: string;
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

const appendRuntimeTaskEvent = async (
  ctx: MutationCtx,
  args: {
    conversationId: Id<"conversations">;
    type: string;
    payload: Record<string, Value | undefined>;
  },
): Promise<void> => {
  const compactPayload: Record<string, Value> = {};
  for (const [key, value] of Object.entries(args.payload)) {
    if (value !== undefined) {
      compactPayload[key] = value;
    }
  }

  await ctx.db.insert("events", {
    conversationId: args.conversationId,
    timestamp: Date.now(),
    type: args.type,
    payload: compactPayload,
  });
};

type SubagentExecutionArgs = {
  conversationId: Id<"conversations">;
  userMessageId: Id<"events">;
  targetDeviceId?: string;
  prompt: string;
  subagentType: string;
  taskId: Id<"tasks">;
  ownerId?: string;
  threadId?: Id<"threads">;
  commandId?: string;
  systemPromptOverride?: string;
  overflowRecoveryAttempt?: number;
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

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // Not valid JSON — return as raw string
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

const selectRecentThreadMessagesByTokens = <
  T extends { content: string; tokenEstimate?: number },
>(
  messages: T[],
  maxTokens: number,
): T[] => {
  if (messages.length === 0) return messages;
  const safeBudget = Math.max(1, Math.floor(maxTokens));
  const selected: T[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const estimate = Math.max(
      1,
      Math.floor(message.tokenEstimate ?? Math.ceil(message.content.length / 4)),
    );
    if (selected.length > 0 && used + estimate > safeBudget) {
      break;
    }
    selected.push(message);
    used += estimate;
  }

  selected.reverse();
  return selected;
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
  if (args.systemPromptOverride?.trim()) {
    effectiveSystemPrompt = args.systemPromptOverride.trim();
  }

  // --- Thread loading ---
  const threadSupported = args.subagentType === "general";
  let threadMessages: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    tokenEstimate?: number;
  }> = [];
  let summaryPair: Array<{ role: "user" | "assistant"; content: string }> = [];

  const loadThreadContext = async () => {
    if (!args.threadId || !threadSupported) {
      summaryPair = [];
      threadMessages = [];
      return;
    }

    const thread = await ctx.runQuery(internal.data.threads.getThreadById, {
      threadId: args.threadId,
    });

    summaryPair = thread?.summary
      ? [
          { role: "user" as const, content: `[Thread context - prior work summary]\n${thread.summary}` },
          { role: "assistant" as const, content: "Understood. I have the context from previous work." },
        ]
      : [];

    const rawMessages = await ctx.runQuery(internal.data.threads.loadThreadMessages, {
      threadId: args.threadId,
    });

    threadMessages = selectRecentThreadMessagesByTokens(
      rawMessages.map((m: {
        role: string;
        content: string;
        toolCallId?: string;
        tokenEstimate?: number;
      }) => ({
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(typeof m.tokenEstimate === "number" ? { tokenEstimate: m.tokenEstimate } : {}),
      })),
      SUBAGENT_THREAD_HISTORY_MAX_TOKENS,
    );
  };

  if (args.threadId && threadSupported && args.ownerId) {
    try {
      await ctx.runMutation(internal.data.threads.touchThread, {
        ownerId: args.ownerId,
        threadId: args.threadId,
      });
      await loadThreadContext();
    } catch {
      // Thread loading failed - proceed without thread context
    }
  }

  const toolContext: DeviceToolContext | undefined = args.targetDeviceId
    ? {
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
        agentType: args.subagentType,
        sourceDeviceId: args.targetDeviceId,
        currentTaskId: args.taskId,
      }
    : undefined;

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
    const fallbackConfig = await resolveFallbackConfig(ctx, args.subagentType, args.ownerId);

    if (args.threadId && threadSupported && isAutoCompactionEnabled()) {
      try {
        const currentThread = await ctx.runQuery(internal.data.threads.getThreadById, {
          threadId: args.threadId,
        });
        if (
          (currentThread?.totalTokenEstimate ?? 0) >=
            SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS
        ) {
          await ctx.runAction(internal.data.threads.compactThread, {
            threadId: args.threadId,
          });
          await loadThreadContext();
        }
      } catch {
        // Best effort: proceed even if pre-request compaction fails.
      }
    }

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
    const promptContent: Array<{ type: "text"; text: string }> = [];
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
    messages.push({ role: "user" as const, content: promptContent });

    const generateTextSharedArgs = {
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
          userMessageId: args.userMessageId,
          targetDeviceId: args.targetDeviceId,
        },
      ),
      messages: messages as ModelMessage[],
      abortSignal: abortController.signal,
      onStepFinish: async ({ toolCalls }: { toolCalls?: Array<{ toolName: string; args?: unknown }> }) => {
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
    };

    const subagentStartTime = Date.now();
    const result = await generateTextWithFailover({
      resolvedConfig,
      fallbackConfig: fallbackConfig ?? undefined,
      sharedArgs: generateTextSharedArgs as Record<string, unknown>,
    });

    // Fire afterChat hook asynchronously for usage logging
    if (args.ownerId) {
      await ctx.scheduler.runAfter(0, internal.agent.hooks.logUsageAsync, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        agentType: args.subagentType,
        model: resolvedConfig.model as string,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
        durationMs: Date.now() - subagentStartTime,
        success: true,
      });
    }

    const text = result.text;
    finished = true;
    await cancelWatcher;

    const postStatus = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (postStatus && postStatus !== "running") {
      return `Task ${postStatus}.\nTask ID: ${args.taskId}`;
    }

    // --- Thread saving (only on success) ---
    if (args.threadId && threadSupported && args.ownerId) {
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
          ownerId: args.ownerId,
          threadId: args.threadId,
          messages: messagesToSave,
        });

        // Check if compaction is needed based on subagent thread budget.
        const updatedThread = await ctx.runQuery(internal.data.threads.getThreadById, {
          threadId: args.threadId,
        });
        const threadTokens = updatedThread?.totalTokenEstimate ?? 0;
        if (threadTokens >= SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS) {
          await ctx.scheduler.runAfter(0, internal.data.threads.compactThread, {
            threadId: args.threadId,
          });
        }
      } catch {
        // Thread saving failed — don't fail the task
      }
    }

    const completion = await ctx.runMutation(internal.agent.tasks.completeTaskRecord, {
      taskId: args.taskId,
      status: "completed",
      result: text,
    });
    if (!completion.applied || completion.task?.status !== "completed") {
      const currentStatus = completion.task?.status ?? "missing";
      return `Task ${currentStatus}.\nTask ID: ${args.taskId}`;
    }

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
    if (isContextOverflowError(error) && overflowRecoveryAttempt < 1) {
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
            force: true,
          });
        } catch {
          // Best effort; continue retry even if compaction fails.
        }
      }

      return await executeSubagentRun(ctx, {
        ...args,
        overflowRecoveryAttempt: overflowRecoveryAttempt + 1,
      });
    }

    const completion = await ctx.runMutation(internal.agent.tasks.completeTaskRecord, {
      taskId: args.taskId,
      status: "error",
      error: errorMessage,
    });
    if (completion.applied && completion.task?.status === "error") {
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
    }

    const finalStatus = completion.task?.status;
    if (finalStatus === "canceled") {
      return `Task canceled.\nTask ID: ${args.taskId}`;
    }
    if (finalStatus === "completed") {
      return `Task completed.\nTask ID: ${args.taskId}`;
    }
    return `Task failed.\nTask ID: ${args.taskId}\n\n--- Error ---\n${errorMessage}`;
  }
};

export const createTaskRecord = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.optional(v.string()),
    description: v.string(),
    prompt: v.string(),
    agentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    maxTaskDepth: v.optional(v.number()),
    commandId: v.optional(v.string()),
  },
  returns: v.object({
    taskId: v.id("tasks"),
    taskDepth: v.number(),
    maxTaskDepth: v.number(),
  }),
  handler: async (ctx, args) => {
    const maxTaskDepth = Math.max(0, Math.floor(args.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH));

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
      commandId: args.commandId,
      status: "running" satisfies TaskStatus,
      taskDepth,
      deliveryCompletedAt: undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
    });

    return { taskId, taskDepth, maxTaskDepth };
  },
});

/**
 * Public task creation API for the local runtime.
 * Creates a task row and emits a task_started event, but does not schedule
 * server-side execution. The Electron local runtime owns execution.
 */
export const createRuntimeTask = mutation({
  args: {
    conversationId: v.id("conversations"),
    description: v.string(),
    prompt: v.string(),
    agentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    commandId: v.optional(v.string()),
    maxTaskDepth: v.optional(v.number()),
  },
  returns: v.object({
    taskId: v.id("tasks"),
    taskDepth: v.number(),
    maxTaskDepth: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);

    const maxTaskDepth = Math.max(
      0,
      Math.floor(args.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH),
    );

    let taskDepth = 1;
    if (args.parentTaskId) {
      const parent = await ctx.db.get(args.parentTaskId);
      if (parent?.taskDepth) {
        taskDepth = parent.taskDepth + 1;
      }
      if (taskDepth > maxTaskDepth) {
        throw new ConvexError({
          code: "LIMIT_EXCEEDED",
          message: `Task depth limit exceeded (${maxTaskDepth})`,
        });
      }
    }

    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      conversationId: args.conversationId,
      parentTaskId: args.parentTaskId,
      description: args.description,
      prompt: args.prompt,
      agentType: args.agentType,
      commandId: args.commandId,
      status: "running" satisfies TaskStatus,
      taskDepth,
      model: `local:${args.agentType}`,
      deliveryCompletedAt: undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
    });

    await appendRuntimeTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_started",
      payload: {
        taskId,
        description: args.description,
        agentType: args.agentType,
        parentTaskId: args.parentTaskId,
        taskDepth,
        maxTaskDepth,
      },
    });

    return { taskId, taskDepth, maxTaskDepth };
  },
});

/**
 * Public completion API for local runtime tasks.
 */
export const completeRuntimeTask = mutation({
  args: {
    taskId: v.id("tasks"),
    status: runtimeFinalTaskStatusValidator,
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.union(v.null(), taskClientValidator),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) {
      return null;
    }

    await requireConversationOwner(ctx, record.conversationId);
    if (record.status !== "running") {
      return toTaskClient(record);
    }

    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: args.status satisfies RuntimeFinalTaskStatus,
      result: args.result,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });

    if (args.status === "completed") {
      await appendRuntimeTaskEvent(ctx, {
        conversationId: record.conversationId,
        type: "task_completed",
        payload: {
          taskId: args.taskId,
          result: args.result,
        },
      });
    } else {
      await appendRuntimeTaskEvent(ctx, {
        conversationId: record.conversationId,
        type: "task_failed",
        payload: {
          taskId: args.taskId,
          error: args.error ?? (args.status === "canceled" ? "Canceled" : "Unknown error"),
        },
      });
    }

    const updated = await ctx.db.get(args.taskId);
    return toTaskClientOrNull(updated);
  },
});

/**
 * Public cancellation API for local runtime tasks.
 */
export const cancelRuntimeTask = mutation({
  args: {
    taskId: v.id("tasks"),
    reason: v.optional(v.string()),
  },
  returns: v.union(v.null(), taskClientValidator),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;
    await requireConversationOwner(ctx, record.conversationId);
    return await applyTaskCancellation(ctx, {
      taskId: args.taskId,
      reason: args.reason,
    });
  },
});

/**
 * Public task query for local runtime polling by task id.
 */
export const getRuntimeTaskById = query({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.union(v.null(), taskClientValidator),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;
    await requireConversationOwner(ctx, record.conversationId);
    return toTaskClient(record);
  },
});

export const completeTaskRecord = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: v.string(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.object({
    applied: v.boolean(),
    task: v.union(v.null(), taskClientValidator),
  }),
  handler: async (ctx, args) => {
    if (!isTaskTerminalStatus(args.status)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Invalid terminal task status: ${args.status}`,
      });
    }
    const current = await ctx.db.get(args.taskId);
    if (!current) {
      return { applied: false, task: null as TaskClient | null };
    }
    if (current.status !== "running") {
      return { applied: false, task: toTaskClient(current) };
    }

    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: args.status,
      result: args.result,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });
    const record = await ctx.db.get(args.taskId);
    return { applied: true, task: toTaskClientOrNull(record) };
  },
});

export const finalizeDeliveredTaskTurn = internalMutation({
  args: {
    taskId: v.id("tasks"),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    userMessageId: v.optional(v.id("events")),
    activeThreadId: v.optional(v.id("threads")),
    threadUserMessage: v.string(),
    responseMessages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        toolCallId: v.optional(v.string()),
      }),
    ),
    assistantText: v.string(),
    usage: v.optional(usageSummaryValidator),
    saveAssistantMessage: v.boolean(),
    shouldResetReminderCounter: v.boolean(),
    turnOutputTokens: v.optional(v.number()),
  },
  returns: v.object({
    applied: v.boolean(),
    assistantSaved: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) {
      return { applied: false, assistantSaved: false };
    }
    if (typeof task.deliveryCompletedAt === "number") {
      return { applied: false, assistantSaved: false };
    }
    if (task.status === "canceled") {
      return { applied: false, assistantSaved: false };
    }

    const now = Date.now();

    if (args.activeThreadId) {
      const messagesToSave: Array<{
        role: string;
        content: string;
        toolCallId?: string;
      }> = [
        {
          role: "user",
          content: args.threadUserMessage,
        },
        ...args.responseMessages,
      ];

      if (messagesToSave.length > 1) {
        await ctx.runMutation(internal.data.threads.saveThreadMessages, {
          ownerId: args.ownerId,
          threadId: args.activeThreadId,
          messages: messagesToSave,
        });
        const updatedThread = await ctx.db.get(args.activeThreadId);
        if (
          updatedThread &&
          updatedThread.totalTokenEstimate >= ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS
        ) {
          await ctx.scheduler.runAfter(0, internal.data.threads.compactThread, {
            threadId: args.activeThreadId,
          });
        }
      }
    }

    const trimmedAssistantText = args.assistantText.trim();
    let assistantSaved = false;
    if (args.saveAssistantMessage && trimmedAssistantText.length > 0) {
      const eventId = await ctx.db.insert("events", {
        conversationId: args.conversationId,
        timestamp: now,
        type: "assistant_message",
        payload: {
          text: trimmedAssistantText,
          taskId: args.taskId,
          ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
          ...(args.usage ? { usage: args.usage } : {}),
        },
      });
      await ctx.db.patch(args.conversationId, { updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.data.event_embeddings.indexEventForSemanticSearch, {
        eventId,
      });
      assistantSaved = true;
    }

    if (args.shouldResetReminderCounter) {
      await ctx.db.patch(args.conversationId, {
        reminderTokensSinceLastInjection: 0,
        forceReminderOnNextTurn: false,
        updatedAt: now,
      });
    } else if (args.turnOutputTokens && args.turnOutputTokens > 0) {
      const conversation = await ctx.db.get(args.conversationId);
      if (conversation) {
        const current = conversation.reminderTokensSinceLastInjection ?? 0;
        await ctx.db.patch(args.conversationId, {
          reminderTokensSinceLastInjection: current + args.turnOutputTokens,
          updatedAt: now,
        });
      }
    }

    await ctx.db.patch(args.taskId, {
      deliveryCompletedAt: now,
      updatedAt: now,
    });

    return { applied: true, assistantSaved };
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
  returns: v.union(v.null(), taskClientValidator),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;
    await requireConversationOwner(ctx, record.conversationId);
    return await applyTaskCancellation(ctx, {
      taskId: args.taskId,
      reason: args.reason,
    });
  },
});

export const cancelTaskInternal = internalMutation({
  args: {
    taskId: v.id("tasks"),
    reason: v.optional(v.string()),
  },
  returns: v.union(v.null(), taskClientValidator),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;
    return await applyTaskCancellation(ctx, {
      taskId: args.taskId,
      reason: args.reason,
    });
  },
});

export const getTaskStatus = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    return record?.status ?? null;
  },
});

export const isTaskDeliveryCompleted = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    return typeof record?.deliveryCompletedAt === "number";
  },
});

export const getById = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.union(v.null(), taskClientValidator),
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
  returns: v.union(v.null(), taskClientValidator),
  handler: async (ctx, args) => {
    const record = await loadTaskByExternalTaskId(ctx, args.taskId);
    if (record) {
      await requireConversationOwner(ctx, record.conversationId);
    }
    return toTaskClientOrNull(record);
  },
});

export const getOutputByExternalIdInternal = internalQuery({
  args: {
    taskId: v.string(),
  },
  returns: v.union(v.null(), taskClientValidator),
  handler: async (ctx, args) => {
    const record = await loadTaskByExternalTaskId(ctx, args.taskId);
    return toTaskClientOrNull(record);
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
      .withIndex("by_conversationId_and_createdAt", (q) => q.eq("conversationId", args.conversationId))
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
    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 200,
      min: 1,
      max: MAX_SYNC_TASKS_QUERY_LIMIT,
    });
    const records = await ctx.db
      .query("tasks")
      .withIndex("by_conversationId_and_updatedAt", (q) =>
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
    latestTaskId: v.union(v.null(), v.id("tasks")),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const latest = await ctx.db
      .query("tasks")
      .withIndex("by_conversationId_and_updatedAt", (q) =>
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
    targetDeviceId: v.optional(v.string()),
    description: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    threadId: v.optional(v.string()),
    threadName: v.optional(v.string()),
    commandId: v.optional(v.string()),
    systemPromptOverride: v.optional(v.string()),
    suppressDelivery: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const conversation: Doc<"conversations"> = await requireConversationOwnerAction(ctx, args.conversationId);
    if (!ALLOWED_SUBAGENT_TYPES.has(args.subagentType)) {
      return `Task denied.\nReason: Unsupported subagent type: ${args.subagentType}`;
    }

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

    const executionTarget = await ctx.runQuery(
      internal.agent.device_resolver.resolveExecutionTarget,
      { ownerId: conversation.ownerId },
    );
    const resolvedTargetDeviceId = executionTarget.targetDeviceId ?? args.targetDeviceId;

    // Resolve thread: threadId takes priority, then threadName lookup/create
    const threadSupported = args.subagentType === "general";
    let resolvedThreadId: Id<"threads"> | undefined;
    let evictedThreadName: string | null = null;

    if (threadSupported) {
      if (args.threadId) {
        // Verify thread exists and reactivate if it was idle/archived.
        const threadRecord = await ctx.runQuery(internal.data.threads.getThreadById, {
          threadId: args.threadId as Id<"threads">,
        });
        if (threadRecord?.name === "Main") {
          return `Task denied.\nReason: The 'Main' thread is reserved for the orchestrator and cannot be used by subagents.`;
        }
        
        const activated = await ctx.runMutation(internal.data.threads.activateThread, {
          ownerId: conversation.ownerId,
          threadId: args.threadId as Id<"threads">,
        });
        if (activated) {
          resolvedThreadId = activated._id;
        }
        // If thread not found, proceed without thread context.
      } else if (args.threadName) {
        if (args.threadName.toLowerCase() === "main") {
          return `Task denied.\nReason: The 'Main' thread is reserved for the orchestrator and cannot be used by subagents. Please choose a different thread name.`;
        }
        
        // Look up existing thread by name and reactivate it, or create new one.
        const existing = await ctx.runQuery(internal.data.threads.getThreadByName, {
          ownerId: conversation.ownerId,
          conversationId: args.conversationId,
          name: args.threadName,
        });
        if (existing) {
          const activated = await ctx.runMutation(internal.data.threads.activateThread, {
            ownerId: conversation.ownerId,
            threadId: existing._id,
          });
          resolvedThreadId = activated?._id;
        } else {
          const threadResult = await ctx.runMutation(internal.data.threads.createThread, {
            ownerId: conversation.ownerId,
            conversationId: args.conversationId,
            name: args.threadName,
          });
          resolvedThreadId = threadResult.threadId;
          if (threadResult.evictedThreadName) {
            evictedThreadName = threadResult.evictedThreadName;
          }
        }
      }
    }

    const created: { taskId: Id<"tasks">; taskDepth: number; maxTaskDepth: number } =
      await ctx.runMutation(internal.agent.tasks.createTaskRecord, {
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: resolvedTargetDeviceId,
        description: args.description,
        prompt: args.prompt,
        agentType: args.subagentType,
        parentTaskId: args.parentTaskId,
        maxTaskDepth: promptBuild.maxTaskDepth,
        commandId: args.commandId,
      });

    const taskId: Id<"tasks"> = created.taskId;
    const taskDepth: number = created.taskDepth;

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_started",
      deviceId: resolvedTargetDeviceId,
      targetDeviceId: resolvedTargetDeviceId,
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
      targetDeviceId: resolvedTargetDeviceId,
      taskId,
    });

    await ctx.scheduler.runAfter(0, internal.agent.tasks.executeSubagent, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: resolvedTargetDeviceId,
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagentType,
      taskId,
      ownerId: conversation.ownerId,
      parentTaskId: args.parentTaskId,
      threadId: resolvedThreadId,
      commandId: args.commandId,
      systemPromptOverride: args.systemPromptOverride,
      suppressDelivery: args.suppressDelivery,
    });

    const parts = [`Task running.\nTask ID: ${taskId}\nElapsed: 0ms`];
    if (evictedThreadName) {
      parts.push(`\nNote: Thread "${evictedThreadName}" was archived to make room for the new thread.`);
    }
    return parts.join("");
  },
});

export const executeSubagent = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.optional(v.string()),
    description: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    taskId: v.id("tasks"),
    ownerId: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    threadId: v.optional(v.id("threads")),
    commandId: v.optional(v.string()),
    systemPromptOverride: v.optional(v.string()),
    suppressDelivery: v.optional(v.boolean()),
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
      threadId: args.threadId,
      commandId: args.commandId,
      systemPromptOverride: args.systemPromptOverride,
    });

    // Deliver result to the orchestrator for top-level tasks only.
    // Nested subagent results flow back through their parent's tool output.
    if (!args.parentTaskId && !args.suppressDelivery) {
      const task = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
        taskId: args.taskId,
      });
      const status = task ?? "completed";

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
        deliveryAttempt: 0,
      });
    }

    return null;
  },
});

export const taskCheckin = internalAction({
  args: {
    conversationId: v.id("conversations"),
    targetDeviceId: v.optional(v.string()),
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
    targetDeviceId: v.optional(v.string()),
    taskId: v.id("tasks"),
    description: v.string(),
    agentType: v.string(),
    result: v.string(),
    status: v.string(),
    ownerId: v.string(),
    deliveryAttempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const alreadyDelivered = await ctx.runQuery(internal.agent.tasks.isTaskDeliveryCompleted, {
      taskId: args.taskId,
    });
    if (alreadyDelivered) {
      return null;
    }

    // Skip delivery if the task was canceled while the subagent was running.
    const taskStatus = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (taskStatus === "canceled") {
      return null;
    }

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

    const toolContext: DeviceToolContext | undefined = args.targetDeviceId
      ? {
          conversationId: args.conversationId,
          userMessageId: args.userMessageId,
          targetDeviceId: args.targetDeviceId,
          agentType: "orchestrator",
          sourceDeviceId: args.targetDeviceId,
        }
      : undefined;

    const resolvedConfig = await resolveModelConfig(
      ctx,
      "orchestrator",
      args.ownerId,
    );
    const deliveryFallbackConfig = await resolveFallbackConfig(
      ctx,
      "orchestrator",
      args.ownerId,
    );
    const orchestratorTurn = await prepareOrchestratorTurn(ctx, {
      conversation,
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      userPayload: {
        kind: "task_delivery",
        text: deliveryMessage,
      },
      history: {
        enabled: true,
        maxTokens: TASK_DELIVERY_HISTORY_MAX_TOKENS,
        microcompact: {
          enabled: false,
        },
      },
    });
    const promptBuild = orchestratorTurn.promptBuild;

    try {
      const deliverySharedArgs = {
        system: promptBuild.systemPrompt,
        tools: createTools(ctx, toolContext, {
          agentType: "orchestrator",
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          userMessageId: args.userMessageId,
          targetDeviceId: args.targetDeviceId,
        }),
        messages: orchestratorTurn.messages as ModelMessage[],
      };

      const genResult = await generateTextWithFailover({
        resolvedConfig,
        fallbackConfig: deliveryFallbackConfig ?? undefined,
        sharedArgs: deliverySharedArgs as Record<string, unknown>,
      });

      const noResponseCalled = hasNoResponseInSteps(
        genResult.steps as Array<{ toolCalls?: Array<{ toolName?: string }> }> | undefined,
      );

      const responseMessages = (genResult.response?.messages ?? []).map((message) => {
        const rawToolCallId = (message as { toolCallId?: unknown }).toolCallId;
        const toolCallId = typeof rawToolCallId === "string"
          ? normalizeToolCallId(rawToolCallId)
          : undefined;
        return {
          role: message.role,
          content: toStoredThreadEnvelope({
            role: message.role,
            content: message.content,
            ...(toolCallId ? { toolCallId } : {}),
          }),
          ...(toolCallId ? { toolCallId } : {}),
        };
      });

      const persistence = await ctx.runMutation(internal.agent.tasks.finalizeDeliveredTaskTurn, {
        taskId: args.taskId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        userMessageId: args.userMessageId,
        activeThreadId: orchestratorTurn.activeThreadId ?? undefined,
        threadUserMessage: orchestratorTurn.threadUserMessage,
        responseMessages,
        assistantText: genResult.text ?? "",
        usage: toUsageSummary(genResult.usage),
        saveAssistantMessage: !noResponseCalled,
        shouldResetReminderCounter: orchestratorTurn.reminderState.shouldInjectDynamicReminder,
        turnOutputTokens: genResult.usage?.outputTokens ?? 0,
      });

      if (persistence.assistantSaved) {
        try {
          await ctx.scheduler.runAfter(0, internal.agent.suggestions.generateSuggestions, {
            conversationId: args.conversationId,
            ownerId: args.ownerId,
          });
        } catch {
          // best-effort
        }
      }
    } catch (error) {
      console.error("deliverTaskResult failed:", (error as Error).message);
      const attempt = args.deliveryAttempt ?? 0;
      if (attempt < 2) {
        await ctx.scheduler.runAfter(
          (attempt + 1) * DELIVERY_RETRY_BACKOFF_MS,
          internal.agent.tasks.deliverTaskResult,
          {
            ...args,
            deliveryAttempt: attempt + 1,
          },
        );
      }
    }

    return null;
  },
});

// ─── Batch Persist Run Chunk ─────────────────────────────────────────────────
// Used by the local agent runtime to persist run data to Convex in chunks.
// Each chunk is idempotent by chunkKey — safe to retry on crash recovery.

const persistChunkEventValidator = v.object({
  type: v.string(),
  toolCallId: v.optional(v.string()),
  toolName: v.optional(v.string()),
  argsPreview: v.optional(v.string()),
  resultPreview: v.optional(v.string()),
  errorText: v.optional(v.string()),
  durationMs: v.optional(v.number()),
  timestamp: v.number(),
});

const persistChunkThreadMessageValidator = v.object({
  role: v.string(),
  content: v.string(),
  toolCallId: v.optional(v.string()),
});

export const batchPersistRunChunk = mutation({
  args: {
    runId: v.string(),
    chunkKey: v.string(),
    chunkIndex: v.number(),
    isFinal: v.boolean(),
    events: v.array(persistChunkEventValidator),
    assistantText: v.optional(v.string()),
    threadMessages: v.optional(v.array(persistChunkThreadMessageValidator)),
    usage: v.optional(v.object({
      inputTokens: v.optional(v.number()),
      outputTokens: v.optional(v.number()),
    })),
    conversationId: v.id("conversations"),
    agentType: v.string(),
    ownerId: v.optional(v.string()),
    activeThreadId: v.optional(v.id("threads")),
    // Finalization flags — parity with finalizeOrchestratorTurn
    reminderTokenCounter: v.optional(v.object({
      reset: v.boolean(),
      outputTokens: v.optional(v.number()),
    })),
  },
  returns: v.object({
    persisted: v.boolean(),
    duplicate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const conversation = await requireConversationOwner(ctx, args.conversationId);
    const ownerId = conversation.ownerId;

    const dedupStatus = await ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
      scope: "persist_chunk_dedup",
      key: args.chunkKey,
      limit: 1,
      windowMs: PERSIST_CHUNK_DEDUP_WINDOW_MS,
      blockMs: PERSIST_CHUNK_DEDUP_WINDOW_MS,
    });
    if (!dedupStatus.allowed) {
      return { persisted: true, duplicate: true };
    }

    // Check for idempotency — if chunkKey already exists, skip
    const existing = await ctx.db
      .query("persist_chunks")
      .withIndex("by_chunkKey", (q) => q.eq("chunkKey", args.chunkKey))
      .first();

    if (existing) {
      return { persisted: true, duplicate: true };
    }

    // Validate payload size (reject > 1MB)
    const payloadSize = JSON.stringify(args.events).length;
    if (payloadSize > MAX_PERSIST_CHUNK_PAYLOAD_BYTES) {
      throw new Error(`Chunk payload too large: ${payloadSize} bytes. Split into smaller chunks.`);
    }

    // Store the chunk
    const insertedChunkId = await ctx.db.insert("persist_chunks", {
      runId: args.runId,
      chunkKey: args.chunkKey,
      chunkIndex: args.chunkIndex,
      isFinal: args.isFinal,
      events: args.events,
      assistantText: args.assistantText,
      threadMessages: args.threadMessages,
      usage: args.usage,
      conversationId: args.conversationId,
      agentType: args.agentType,
      ownerId,
      createdAt: Date.now(),
    });

    // If this is the final chunk, perform finalization
    if (args.isFinal) {
      // Canonicalize finalization to a single chunk document per run, even if
      // duplicate inserts happen under concurrent retries.
      const finalChunks = await ctx.db
        .query("persist_chunks")
        .withIndex("by_runId_and_isFinal", (q) =>
          q.eq("runId", args.runId).eq("isFinal", true),
        )
        .collect();
      finalChunks.sort(
        (a, b) => a.chunkIndex - b.chunkIndex || a._creationTime - b._creationTime,
      );
      const canonicalFinal = finalChunks[0];
      if (!canonicalFinal || canonicalFinal._id !== insertedChunkId) {
        return { persisted: true, duplicate: false };
      }

      const now = Date.now();

      // 1. Write assistant_message event if we have text
      if (args.assistantText && args.assistantText.trim().length > 0) {
        await ctx.db.insert("events", {
          conversationId: args.conversationId,
          timestamp: now,
          type: "assistant_message",
          payload: {
            text: args.assistantText,
            agentType: args.agentType,
            source: "local",
            runId: args.runId,
          },
        });
      }

      // 2. Persist thread messages if provided
      if (args.threadMessages && args.threadMessages.length > 0 && args.activeThreadId) {
        await ctx.runMutation(internal.data.threads.saveThreadMessages, {
          ownerId,
          threadId: args.activeThreadId,
          messages: args.threadMessages,
        });
      }

      // 3. Log usage
      if (args.usage) {
        const totalTokens =
          (args.usage.inputTokens ?? 0) + (args.usage.outputTokens ?? 0);

        // Count tool calls across ALL chunks for this run
        const allChunks = await ctx.db
          .query("persist_chunks")
          .withIndex("by_runId_and_chunkIndex", (q) => q.eq("runId", args.runId))
          .collect();

        let toolCalls = 0;
        for (const chunk of allChunks) {
          toolCalls += chunk.events.filter(
            (e) => e.type === "tool_call",
          ).length;
        }

        await ctx.db.insert("usage_logs", {
          ownerId,
          conversationId: args.conversationId,
          agentType: args.agentType,
          model: `local:${args.agentType}`,
          inputTokens: args.usage.inputTokens,
          outputTokens: args.usage.outputTokens,
          totalTokens,
          durationMs: 0, // Local runs don't have a single duration
          success: true,
          toolCalls: toolCalls > 0 ? toolCalls : undefined,
          createdAt: now,
        });
      }

      // 4. Reminder token counter update
      if (args.reminderTokenCounter) {
        try {
          if (args.reminderTokenCounter.reset) {
            await ctx.runMutation(internal.conversations.updateReminderTokenCounter, {
              conversationId: args.conversationId,
              resetTo: 0,
            });
          } else if ((args.reminderTokenCounter.outputTokens ?? 0) > 0) {
            await ctx.runMutation(internal.conversations.updateReminderTokenCounter, {
              conversationId: args.conversationId,
              incrementBy: args.reminderTokenCounter.outputTokens,
            });
          }
        } catch {
          // Best effort
        }
      }

      // Suggestions and thread compaction are handled locally by the desktop.
    }

    return { persisted: true, duplicate: false };
  },
});

/** Check if a final persist chunk exists for a given run (used by crash recovery) */
export const hasFinalPersistChunk = internalQuery({
  args: {
    runId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const chunk = await ctx.db
      .query("persist_chunks")
      .withIndex("by_runId_and_isFinal", (q) =>
        q.eq("runId", args.runId).eq("isFinal", true),
      )
      .first();
    return chunk !== null;
  },
});
