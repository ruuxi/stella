/**
 * Store thread + agent loop.
 *
 * The Store agent runs entirely server-side: this Convex action holds
 * the system prompt, owns the conversation history, drives the LLM
 * tool loop, and persists the assistant's blueprint message. The
 * desktop client never sees the system prompt and never executes the
 * model — it only handles narrow read-only host tool calls (git_log,
 * git_show, read_file, list_files, grep, ask_question) when the agent
 * asks for them, via the pending-tool-call queue defined below.
 *
 * Threads are per-owner singletons. Messages stream as standard rows;
 * pending assistant messages get patched on completion.
 */
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "../_generated/server";
import { ConvexError, Infer, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireUserId, requireSensitiveUserIdAction } from "../auth";
import { requireBoundedString } from "../shared_validators";
import {
  store_thread_message_role_validator,
  store_thread_message_validator,
  store_thread_pending_tool_call_validator,
  store_thread_tool_call_status_validator,
} from "../schema/store";
import {
  STORE_THREAD_SYSTEM_PROMPT,
  buildStoreThreadOpeningUserMessage,
} from "../prompts/store_thread";
import {
  resolveModelConfig,
  resolveFallbackConfig,
} from "../agent/model_resolver";
import { streamTextWithFailover } from "../agent/model_execution";
import { assertManagedUsageAllowed } from "../lib/managed_billing";
import {
  enforceActionRateLimit,
  RATE_EXPENSIVE,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import { enforceStoreReleaseReviewOrThrow } from "../lib/store_release_reviews";
import type { BackendToolDefinition, BackendToolSet } from "../tools/types";

const STORE_AGENT_TYPE = "store_thread" as const;

const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const MAX_USER_TEXT = 8_000;
const MAX_FEATURE_NAME_COUNT = 12;
const MAX_FEATURE_NAME_LENGTH = 120;
const MAX_RELEASE_NOTES_LENGTH = 4_000;
const MAX_DISPLAY_NAME = 120;
const MAX_DESCRIPTION = 4_000;
const MAX_ICON_URL = 2_048;
const MAX_AUTHORED_AT_COMMIT = 80;
const MAX_HISTORY_MESSAGES = 60;
const TOOL_CALL_POLL_INTERVAL_MS = 200;
const TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per tool call
const AGENT_MAX_STEPS = 20;

const normalizeDeviceId = (value: string) => {
  const normalized = value.trim();
  if (!normalized) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "deviceId is required.",
    });
  }
  requireBoundedString(normalized, "deviceId", 200);
  return normalized;
};

const normalizePackageId = (value: string) => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packageId", 64);
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Package ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const normalizeRequiredText = (
  value: string,
  fieldName: string,
  maxLength: number,
) => {
  const normalized = value.trim();
  if (!normalized) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} is required`,
    });
  }
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeOptionalText = (
  value: string | undefined,
  fieldName: string,
  maxLength: number,
) => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const resolveCallerAuthorHandle = async (
  ctx: {
    runQuery: (
      fn: typeof internal.data.user_profiles.getHandleForOwnerInternal,
      args: { ownerId: string },
    ) => Promise<string | null>;
  },
  ownerId: string,
): Promise<string | undefined> => {
  try {
    const handle = await ctx.runQuery(
      internal.data.user_profiles.getHandleForOwnerInternal,
      { ownerId },
    );
    return handle?.trim() || undefined;
  } catch {
    return undefined;
  }
};

// ── thread + message helpers ─────────────────────────────────────────────────

const getOrCreateThreadFor = async (
  ctx: MutationCtx,
  ownerId: string,
): Promise<Id<"store_threads">> => {
  const existing = await ctx.db
    .query("store_threads")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (existing) return existing._id;
  const now = Date.now();
  return await ctx.db.insert("store_threads", {
    ownerId,
    createdAt: now,
    updatedAt: now,
  });
};

export const getOrCreateThreadInternal = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, args): Promise<Id<"store_threads">> => {
    return await getOrCreateThreadFor(ctx, args.ownerId);
  },
});

export const insertMessageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    threadRef: v.id("store_threads"),
    role: store_thread_message_role_validator,
    text: v.string(),
    isBlueprint: v.optional(v.boolean()),
    pending: v.optional(v.boolean()),
    attachedFeatureNames: v.optional(v.array(v.string())),
    editingBlueprint: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"store_thread_messages">> => {
    const now = Date.now();
    const ref = await ctx.db.insert("store_thread_messages", {
      ownerId: args.ownerId,
      threadRef: args.threadRef,
      role: args.role,
      text: args.text,
      ...(args.isBlueprint ? { isBlueprint: true } : {}),
      ...(args.pending ? { pending: true } : {}),
      ...(args.attachedFeatureNames && args.attachedFeatureNames.length > 0
        ? { attachedFeatureNames: args.attachedFeatureNames }
        : {}),
      ...(args.editingBlueprint ? { editingBlueprint: true } : {}),
      createdAt: now,
    });
    await ctx.db.patch(args.threadRef, { updatedAt: now });
    return ref;
  },
});

export const patchMessageInternal = internalMutation({
  args: {
    messageId: v.id("store_thread_messages"),
    text: v.optional(v.string()),
    pending: v.optional(v.boolean()),
    isBlueprint: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.messageId);
    if (!existing) return null;
    // Cancellation guard: once a turn has been finalized (pending
    // flipped to false by either the agent loop wrapping up or the
    // user clicking Stop), later patches are silently dropped. This
    // prevents the agent loop's end-of-turn patch from overwriting
    // the "Stopped." text the cancel mutation just wrote.
    if (existing.pending !== true) {
      return null;
    }
    const patch: Record<string, unknown> = {};
    if (args.text !== undefined) patch.text = args.text;
    if (args.pending !== undefined) patch.pending = args.pending;
    if (args.isBlueprint !== undefined) patch.isBlueprint = args.isBlueprint;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.messageId, patch);
    }
    return null;
  },
});

export const listMessagesInternal = internalQuery({
  args: { threadRef: v.id("store_threads"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cap = args.limit ?? MAX_HISTORY_MESSAGES;
    return await ctx.db
      .query("store_thread_messages")
      .withIndex("by_threadRef_and_createdAt", (q) =>
        q.eq("threadRef", args.threadRef),
      )
      .order("desc")
      .take(Math.max(1, Math.min(200, cap)));
  },
});

/**
 * Walk the thread's messages newest-first and return the first
 * non-denied, unpublished blueprint draft. Bounded by the thread
 * itself; the index walk short-circuits at the first hit, so even
 * very long threads resolve in O(scan-until-hit). The publish action
 * and the sendMessage opening-prepend path both use this so the UI's
 * Publish button never sees a blueprint the server can't find.
 */
export const findLatestPublishableBlueprintInternal = internalQuery({
  args: { threadRef: v.id("store_threads") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_thread_messages")
      .withIndex("by_threadRef_and_createdAt", (q) =>
        q.eq("threadRef", args.threadRef),
      )
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("isBlueprint"), true),
          q.neq(q.field("denied"), true),
          q.neq(q.field("published"), true),
        ),
      )
      .first();
  },
});

export const markBlueprintPublishedInternal = internalMutation({
  args: {
    messageId: v.id("store_thread_messages"),
    releaseNumber: v.number(),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.isBlueprint !== true) return null;
    await ctx.db.patch(args.messageId, {
      published: true,
      publishedReleaseNumber: args.releaseNumber,
    });
    await ctx.db.patch(message.threadRef, { updatedAt: Date.now() });
    return null;
  },
});

// ── pending tool-call queue ──────────────────────────────────────────────────

export const enqueueToolCallInternal = internalMutation({
  args: {
    ownerId: v.string(),
    threadRef: v.id("store_threads"),
    targetDeviceId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    argsJson: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("store_thread_pending_tool_calls", {
      ownerId: args.ownerId,
      threadRef: args.threadRef,
      targetDeviceId: args.targetDeviceId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      argsJson: args.argsJson,
      status: "pending",
      createdAt: now,
    });
  },
});

export const getToolCallInternal = internalQuery({
  args: { toolCallId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_thread_pending_tool_calls")
      .withIndex("by_toolCallId", (q) => q.eq("toolCallId", args.toolCallId))
      .unique();
  },
});

export const cleanupCompletedToolCallInternal = internalMutation({
  args: { toolCallId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("store_thread_pending_tool_calls")
      .withIndex("by_toolCallId", (q) => q.eq("toolCallId", args.toolCallId))
      .unique();
    if (row) {
      await ctx.db.delete(row._id);
    }
  },
});

// ── public queries ───────────────────────────────────────────────────────────

export const getThread = query({
  args: {},
  returns: v.object({
    threadId: v.union(v.null(), v.id("store_threads")),
    messages: v.array(store_thread_message_validator),
  }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const thread = await ctx.db
      .query("store_threads")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (!thread) {
      return { threadId: null, messages: [] };
    }
    const messages = await ctx.db
      .query("store_thread_messages")
      .withIndex("by_threadRef_and_createdAt", (q) =>
        q.eq("threadRef", thread._id),
      )
      .order("asc")
      .take(500);
    return {
      threadId: thread._id,
      messages: messages as Array<Infer<typeof store_thread_message_validator>>,
    };
  },
});

/**
 * Returns the latest pending tool call for the caller's thread (or
 * null). The desktop client subscribes to this and runs whatever the
 * agent asked for. Read-side only — the actual execute path is
 * `completeToolCall` below.
 */
export const peekPendingToolCall = query({
  args: { deviceId: v.string() },
  returns: v.union(store_thread_pending_tool_call_validator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const deviceId = normalizeDeviceId(args.deviceId);
    const thread = await ctx.db
      .query("store_threads")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (!thread) return null;
    const row = await ctx.db
      .query("store_thread_pending_tool_calls")
      .withIndex(
        "by_threadRef_and_targetDeviceId_and_status_and_createdAt",
        (q) =>
          q
            .eq("threadRef", thread._id)
            .eq("targetDeviceId", deviceId)
            .eq("status", "pending"),
      )
      .order("asc")
      .first();
    return row;
  },
});

/**
 * Stop a running agent turn. Marks the latest pending assistant
 * message as "Stopped." and errors any pending tool calls so the
 * agent loop's polling waits return immediately. The action's
 * end-of-turn patch is no-op'd by `patchMessageInternal`'s
 * cancellation guard.
 */
export const cancelInFlightTurn = mutation({
  args: {},
  returns: v.object({
    cancelledMessage: v.boolean(),
    cancelledToolCalls: v.number(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const thread = await ctx.db
      .query("store_threads")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (!thread) {
      return { cancelledMessage: false, cancelledToolCalls: 0 };
    }

    // Latest pending assistant message (newest first).
    const pendingMessage = await ctx.db
      .query("store_thread_messages")
      .withIndex("by_threadRef_and_createdAt", (q) =>
        q.eq("threadRef", thread._id),
      )
      .order("desc")
      .filter((q) => q.eq(q.field("pending"), true))
      .first();
    let cancelledMessage = false;
    if (pendingMessage) {
      await ctx.db.patch(pendingMessage._id, {
        text: "Stopped.",
        pending: false,
      });
      cancelledMessage = true;
    }

    // Drain pending tool calls so the agent loop's polling waits
    // wake up and return.
    const pendingToolCalls = await ctx.db
      .query("store_thread_pending_tool_calls")
      .withIndex("by_threadRef_and_status_and_createdAt", (q) =>
        q.eq("threadRef", thread._id).eq("status", "pending"),
      )
      .take(50);
    const now = Date.now();
    for (const row of pendingToolCalls) {
      await ctx.db.patch(row._id, {
        status: "error",
        errorMessage: "Cancelled by user.",
        completedAt: now,
      });
    }

    return {
      cancelledMessage,
      cancelledToolCalls: pendingToolCalls.length,
    };
  },
});

/**
 * Mark the latest non-denied blueprint draft as denied. The badge in
 * chat stays (struck through) so the conversation history reads
 * cleanly; the next agent turn's opening-prepend skips this draft and
 * walks back to the previous publishable one (if any). The Publish
 * button hides because `findLatestPublishableBlueprintInternal`
 * filters out denied rows.
 */
export const denyLatestBlueprint = mutation({
  args: {},
  returns: v.object({ denied: v.boolean() }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const thread = await ctx.db
      .query("store_threads")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (!thread) return { denied: false };
    const target = await ctx.db
      .query("store_thread_messages")
      .withIndex("by_threadRef_and_createdAt", (q) =>
        q.eq("threadRef", thread._id),
      )
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("isBlueprint"), true),
          q.neq(q.field("denied"), true),
        ),
      )
      .first();
    if (!target) return { denied: false };
    await ctx.db.patch(target._id, { denied: true });
    await ctx.db.patch(thread._id, { updatedAt: Date.now() });
    return { denied: true };
  },
});

export const completeToolCall = mutation({
  args: {
    toolCallId: v.string(),
    deviceId: v.string(),
    status: store_thread_tool_call_status_validator,
    resultText: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const deviceId = normalizeDeviceId(args.deviceId);
    const row = await ctx.db
      .query("store_thread_pending_tool_calls")
      .withIndex("by_toolCallId", (q) => q.eq("toolCallId", args.toolCallId))
      .unique();
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Tool call not found.",
      });
    }
    if (row.ownerId !== ownerId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Tool call does not belong to caller.",
      });
    }
    if (row.targetDeviceId !== deviceId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Tool call is targeted to a different device.",
      });
    }
    if (row.status !== "pending") {
      // Idempotent: completing an already-completed row is a no-op.
      return null;
    }
    if (args.status === "pending") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Cannot mark a tool call as still pending.",
      });
    }
    await ctx.db.patch(row._id, {
      status: args.status,
      ...(args.resultText !== undefined ? { resultText: args.resultText } : {}),
      ...(args.errorMessage !== undefined
        ? { errorMessage: args.errorMessage }
        : {}),
      completedAt: Date.now(),
    });
    return null;
  },
});

// ── send message + agent loop ────────────────────────────────────────────────

const CLIENT_TOOL_NAMES = [
  "git_log",
  "git_show",
  "git_head",
  "read_file",
  "list_files",
  "grep",
  "ask_question",
] as const;

type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number];

const CLIENT_TOOL_PARAMETERS: Record<
  ClientToolName,
  Record<string, unknown>
> = {
  git_log: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "number",
        description: "Max commits (default 20, max 100).",
      },
    },
  },
  git_show: {
    type: "object",
    additionalProperties: false,
    properties: {
      hash: {
        type: "string",
        description: "Commit hash (full or short).",
      },
    },
    required: ["hash"],
  },
  git_head: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  read_file: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Repo-relative path." },
    },
    required: ["path"],
  },
  list_files: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Repo-relative directory path." },
    },
    required: ["path"],
  },
  grep: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string", description: "Regex pattern (ripgrep)." },
      path: { type: "string", description: "Optional path to scope search." },
    },
    required: ["pattern"],
  },
  ask_question: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string" },
      options: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 6,
      },
    },
    required: ["question", "options"],
  },
};

const CLIENT_TOOL_DESCRIPTIONS: Record<ClientToolName, string> = {
  git_log:
    "List recent self-mod commits on the user's machine. Returns subject, date, and changed files.",
  git_show:
    "Show a commit's full message and diff. Pass a commit hash from git_log.",
  git_head: "Return the current HEAD commit hash.",
  read_file: "Read a file from the local checkout (UTF-8, capped at ~50KB).",
  list_files: "List entries in a directory.",
  grep: "Ripgrep-style search across the repo.",
  ask_question:
    "Surface a multiple-choice question to the user. The user's pick comes back as their next message — call this only when the scope is genuinely ambiguous.",
};

const buildClientTool = (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    threadRef: Id<"store_threads">;
    targetDeviceId: string;
  },
  toolName: ClientToolName,
): BackendToolDefinition => ({
  name: toolName,
  description: CLIENT_TOOL_DESCRIPTIONS[toolName],
  parameters: CLIENT_TOOL_PARAMETERS[toolName],
  execute: async (rawArgs) => {
    const toolCallId = `stc:${crypto.randomUUID()}`;
    await ctx.runMutation(internal.data.store_thread.enqueueToolCallInternal, {
      ownerId: args.ownerId,
      threadRef: args.threadRef,
      targetDeviceId: args.targetDeviceId,
      toolCallId,
      toolName,
      argsJson: JSON.stringify(rawArgs ?? {}),
    });
    const deadline = Date.now() + TOOL_CALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const row = await ctx.runQuery(
        internal.data.store_thread.getToolCallInternal,
        { toolCallId },
      );
      if (!row) {
        return "Tool call disappeared before completion.";
      }
      if (row.status === "complete") {
        const text = row.resultText ?? "";
        await ctx.runMutation(
          internal.data.store_thread.cleanupCompletedToolCallInternal,
          { toolCallId },
        );
        return text;
      }
      if (row.status === "error") {
        const message = row.errorMessage ?? "Tool call failed.";
        await ctx.runMutation(
          internal.data.store_thread.cleanupCompletedToolCallInternal,
          { toolCallId },
        );
        return `Error: ${message}`;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, TOOL_CALL_POLL_INTERVAL_MS),
      );
    }
    // Timed out — leave the row in place so the desktop knows it was
    // attempted, but fail this tool call so the agent can recover.
    return "Tool call timed out (no response from the user's machine).";
  },
});

const buildSetBlueprintTool = (
  ctx: ActionCtx,
  args: { ownerId: string; threadRef: Id<"store_threads"> },
): BackendToolDefinition => ({
  name: "set_blueprint",
  description:
    "Write the current draft blueprint markdown to the side panel. Call this whenever you have a refreshed blueprint ready for the user to review. Each call replaces any previous draft. The user clicks Publish in the side panel to ship the latest one.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      markdown: {
        type: "string",
        description: "The full blueprint markdown.",
      },
    },
    required: ["markdown"],
  },
  execute: async (rawArgs) => {
    const markdown =
      typeof rawArgs?.markdown === "string" ? rawArgs.markdown.trim() : "";
    if (!markdown) {
      return "Error: blueprint markdown cannot be empty.";
    }
    // No size cap — blueprints carry the implementing instructions for
    // the receiver agent and may legitimately need to be large (a full
    // skill file body, several reference snippets, etc.). Convex's row
    // value limit (~1 MB) is the only ceiling. The chat-history path
    // stubs blueprint messages so unbounded drafts don't bloat the
    // model context — only the latest draft is injected once per turn
    // via the opening user message.
    await ctx.runMutation(internal.data.store_thread.insertMessageInternal, {
      ownerId: args.ownerId,
      threadRef: args.threadRef,
      role: "assistant",
      text: markdown,
      isBlueprint: true,
    });
    return "Blueprint draft saved. The user can review it in the side panel and click Publish when ready.";
  },
});

const buildStoreThreadTools = (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    threadRef: Id<"store_threads">;
    targetDeviceId: string;
  },
): BackendToolSet => {
  const set: BackendToolSet = {};
  for (const toolName of CLIENT_TOOL_NAMES) {
    set[toolName] = buildClientTool(ctx, args, toolName);
  }
  set.set_blueprint = buildSetBlueprintTool(ctx, args);
  return set;
};

const BLUEPRINT_STUB_PREFIX = "[Blueprint draft saved";

const stubBlueprintForHistory = (
  row: Infer<typeof store_thread_message_validator>,
): string => {
  const denied = row.denied ? " — denied by user" : "";
  return `${BLUEPRINT_STUB_PREFIX} (${row.text.length} chars${denied}).]`;
};

const buildHistoryMessages = (
  rows: Array<Infer<typeof store_thread_message_validator>>,
): Array<{
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
}> => {
  // Keep the most recent N (after sorting by createdAt asc) and drop
  // pending placeholders. Blueprint messages are replaced with a
  // short stub — the model would otherwise re-receive every prior
  // draft (potentially hundreds of KB each) every turn. The latest
  // publishable draft is injected separately via the opening user
  // message in `sendMessage`, so the agent still has it for
  // refinement context.
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const filtered = sorted.filter(
    (row) => !row.pending && (row.role === "user" || row.role === "assistant"),
  );
  const recent = filtered.slice(-MAX_HISTORY_MESSAGES);
  return recent.map((row) => ({
    role: row.role as "user" | "assistant",
    content: [
      {
        type: "text",
        text: row.isBlueprint ? stubBlueprintForHistory(row) : row.text,
      },
    ],
  }));
};

export const sendMessage = action({
  args: {
    text: v.string(),
    deviceId: v.string(),
    attachedFeatureNames: v.optional(v.array(v.string())),
    editingBlueprint: v.optional(v.boolean()),
  },
  returns: v.object({
    threadId: v.id("store_threads"),
    userMessageId: v.id("store_thread_messages"),
    assistantMessageId: v.id("store_thread_messages"),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    threadId: Id<"store_threads">;
    userMessageId: Id<"store_thread_messages">;
    assistantMessageId: Id<"store_thread_messages">;
  }> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_thread_send_message",
      ownerId,
      RATE_EXPENSIVE,
      "Too many Store agent requests. Please wait a moment.",
    );

    const userText = args.text.trim();
    const deviceId = normalizeDeviceId(args.deviceId);
    if (!userText) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Message text is required.",
      });
    }
    requireBoundedString(userText, "text", MAX_USER_TEXT);
    const attachedFeatureNames = (args.attachedFeatureNames ?? [])
      .slice(0, MAX_FEATURE_NAME_COUNT)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => name.slice(0, MAX_FEATURE_NAME_LENGTH));
    const editingBlueprint = Boolean(args.editingBlueprint);

    const threadRef = await ctx.runMutation(
      internal.data.store_thread.getOrCreateThreadInternal,
      { ownerId },
    );

    const userMessageId = await ctx.runMutation(
      internal.data.store_thread.insertMessageInternal,
      {
        ownerId,
        threadRef,
        role: "user",
        text: userText,
        ...(attachedFeatureNames.length > 0 ? { attachedFeatureNames } : {}),
        ...(editingBlueprint ? { editingBlueprint: true } : {}),
      },
    );

    // Pending placeholder so the side panel renders a "thinking" row
    // while the agent loop runs.
    const assistantMessageId = await ctx.runMutation(
      internal.data.store_thread.insertMessageInternal,
      {
        ownerId,
        threadRef,
        role: "assistant",
        text: "",
        pending: true,
      },
    );

    try {
      const access = await assertManagedUsageAllowed(ctx, ownerId);
      const resolvedConfig = await resolveModelConfig(
        ctx,
        STORE_AGENT_TYPE,
        ownerId,
        { access },
      );
      const fallbackConfig = await resolveFallbackConfig(
        ctx,
        STORE_AGENT_TYPE,
        ownerId,
        { access },
      );

      const tools = buildStoreThreadTools(ctx, {
        ownerId,
        threadRef,
        targetDeviceId: deviceId,
      });

      const historyRows = await ctx.runQuery(
        internal.data.store_thread.listMessagesInternal,
        { threadRef, limit: MAX_HISTORY_MESSAGES + 4 },
      );
      const historyMessages = buildHistoryMessages(
        historyRows as Array<Infer<typeof store_thread_message_validator>>,
      );
      // The latest publishable blueprint draft is injected into the
      // opening user message so the agent has the current draft for
      // refinement without paying the token cost of carrying it
      // through every prior turn (history stubs blueprint messages).
      const latestBlueprintRow = await ctx.runQuery(
        internal.data.store_thread.findLatestPublishableBlueprintInternal,
        { threadRef },
      );
      const latestBlueprintMarkdown =
        latestBlueprintRow && typeof latestBlueprintRow.text === "string"
          ? latestBlueprintRow.text
          : undefined;
      // The history already includes the user message we just inserted;
      // replace its content with the enriched opening that mentions the
      // attached features and (if any) embeds the latest blueprint
      // draft so the agent always sees them.
      if (historyMessages.length > 0) {
        const last = historyMessages[historyMessages.length - 1];
        if (last && last.role === "user") {
          last.content = [
            {
              type: "text",
              text: buildStoreThreadOpeningUserMessage({
                attachedFeatureNames,
                userText,
                editingBlueprint,
                ...(latestBlueprintMarkdown
                  ? { latestBlueprintMarkdown }
                  : {}),
              }),
            },
          ];
        }
      }

      const sharedArgs = {
        system: STORE_THREAD_SYSTEM_PROMPT,
        tools,
        maxSteps: AGENT_MAX_STEPS,
        messages: historyMessages,
      };

      const result = await streamTextWithFailover({
        resolvedConfig,
        fallbackConfig: fallbackConfig ?? undefined,
        sharedArgs: sharedArgs as Record<string, unknown>,
      });
      const finalText = (await result.text)?.trim() ?? "";

      await ctx.runMutation(internal.data.store_thread.patchMessageInternal, {
        messageId: assistantMessageId,
        text: finalText || "Done.",
        pending: false,
      });
    } catch (error) {
      const message = (error as Error)?.message ?? "Store agent failed.";
      await ctx.runMutation(internal.data.store_thread.patchMessageInternal, {
        messageId: assistantMessageId,
        text: `Sorry — something went wrong: ${message}`,
        pending: false,
      });
      throw error;
    }

    return { threadId: threadRef, userMessageId, assistantMessageId };
  },
});

// ── publish ──────────────────────────────────────────────────────────────────

const findLatestBlueprintMessage = async (
  ctx: { runQuery: ActionCtx["runQuery"] },
  threadRef: Id<"store_threads">,
): Promise<{ id: Id<"store_thread_messages">; text: string } | null> => {
  const row = await ctx.runQuery(
    internal.data.store_thread.findLatestPublishableBlueprintInternal,
    { threadRef },
  );
  if (!row || typeof row.text !== "string") return null;
  return { id: row._id, text: row.text };
};

export const publishLatestBlueprint = action({
  args: {
    packageId: v.string(),
    displayName: v.string(),
    description: v.string(),
    category: v.optional(
      v.union(
        v.literal("apps-games"),
        v.literal("productivity"),
        v.literal("customization"),
        v.literal("skills-agents"),
        v.literal("integrations"),
        v.literal("other"),
      ),
    ),
    releaseNotes: v.optional(v.string()),
    iconUrl: v.optional(v.string()),
    authoredAtCommit: v.optional(v.string()),
    /**
     * When true, publish as an update to an existing package the user
     * already owns. Otherwise publish a brand-new package.
     */
    asUpdate: v.optional(v.boolean()),
  },
  returns: v.object({
    packageId: v.string(),
    releaseNumber: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ packageId: string; releaseNumber: number }> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    const thread = await ctx.runQuery(
      internal.data.store_thread.getThreadByOwnerInternal,
      { ownerId },
    );
    if (!thread) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No store thread for this user yet.",
      });
    }
    const blueprint = await findLatestBlueprintMessage(ctx, thread._id);
    if (!blueprint) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No blueprint draft found. Ask the agent to draft one first.",
      });
    }

    await enforceActionRateLimit(
      ctx,
      "store_thread_publish",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many publishes. Please wait before publishing again.",
    );
    const trimmedPackageId = normalizePackageId(args.packageId);
    const trimmedDisplayName = normalizeRequiredText(
      args.displayName,
      "displayName",
      MAX_DISPLAY_NAME,
    );
    const trimmedDescription = normalizeRequiredText(
      args.description,
      "description",
      MAX_DESCRIPTION,
    );
    const trimmedReleaseNotes = normalizeOptionalText(
      args.releaseNotes,
      "releaseNotes",
      MAX_RELEASE_NOTES_LENGTH,
    );
    const iconUrl = normalizeOptionalText(
      args.iconUrl,
      "iconUrl",
      MAX_ICON_URL,
    );
    const authoredAtCommit = normalizeOptionalText(
      args.authoredAtCommit,
      "authoredAtCommit",
      MAX_AUTHORED_AT_COMMIT,
    );
    const manifest = {
      ...(args.category ? { category: args.category } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(authoredAtCommit ? { authoredAtCommit } : {}),
    };
    await enforceStoreReleaseReviewOrThrow(ctx, {
      ownerId,
      packageId: trimmedPackageId,
      displayName: trimmedDisplayName,
      description: trimmedDescription,
      releaseSummary: trimmedReleaseNotes,
      artifactBody: blueprint.text,
    });
    const authorHandle = await resolveCallerAuthorHandle(ctx, ownerId);

    if (args.asUpdate) {
      const result = (await ctx.runMutation(
        internal.data.store_packages.createUpdateReleaseRecord,
        {
          ownerId,
          packageId: trimmedPackageId,
          ...(trimmedReleaseNotes ? { releaseNotes: trimmedReleaseNotes } : {}),
          manifest,
          blueprintMarkdown: blueprint.text,
          ...(manifest.iconUrl ? { iconUrl: manifest.iconUrl } : {}),
          ...(authorHandle ? { authorHandle } : {}),
        },
      )) as { release: { packageId: string; releaseNumber: number } };
      await ctx.runMutation(
        internal.data.store_thread.markBlueprintPublishedInternal,
        {
          messageId: blueprint.id,
          releaseNumber: result.release.releaseNumber,
        },
      );
      return {
        packageId: result.release.packageId,
        releaseNumber: result.release.releaseNumber,
      };
    }

    const result = (await ctx.runMutation(
      internal.data.store_packages.createFirstReleaseRecord,
      {
        ownerId,
        packageId: trimmedPackageId,
        displayName: trimmedDisplayName,
        description: trimmedDescription,
        ...(args.category ? { category: args.category } : {}),
        ...(trimmedReleaseNotes ? { releaseNotes: trimmedReleaseNotes } : {}),
        manifest,
        blueprintMarkdown: blueprint.text,
        ...(manifest.iconUrl ? { iconUrl: manifest.iconUrl } : {}),
        ...(authorHandle ? { authorHandle } : {}),
      },
    )) as { release: { packageId: string; releaseNumber: number } };
    await ctx.runMutation(
      internal.data.store_thread.markBlueprintPublishedInternal,
      {
        messageId: blueprint.id,
        releaseNumber: result.release.releaseNumber,
      },
    );
    return {
      packageId: result.release.packageId,
      releaseNumber: result.release.releaseNumber,
    };
  },
});

export const getThreadByOwnerInternal = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_threads")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
  },
});
