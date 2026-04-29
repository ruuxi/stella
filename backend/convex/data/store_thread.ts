import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { ConvexError, v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  requireSensitiveUserIdentityAction,
  requireUserId,
} from "../auth";
import {
  enforceActionRateLimit,
  enforceMutationRateLimit,
  RATE_HOT_PATH,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import {
  store_thread_candidates_payload_validator,
  store_thread_commit_validator,
  store_thread_draft_payload_validator,
  store_thread_message_role_validator,
} from "../schema/store";
import {
  buildStoreThreadCatalogContext,
  buildStoreThreadOpeningUserMessage,
  STORE_THREAD_SYSTEM_PROMPT,
} from "../prompts/store_thread";
import { resolveFallbackConfig, resolveModelConfig } from "../agent/model_resolver";
import { streamTextWithFailover, splitDurationAcrossModels, usageSummaryFromFinish } from "../agent/model_execution";
import { assertManagedUsageAllowed, scheduleManagedUsage } from "../lib/managed_billing";
import {
  buildStoreReleaseArtifactFromCandidate,
  normalizeStoreCategory,
  type StorePackageCategory,
  type StorePublishCandidateBundle,
} from "../lib/store_artifacts";
import { generateStoreIconUrl } from "../lib/store_icon";
import type { BackendToolDefinition, BackendToolSet } from "../tools/types";
import { scrubProviderTerms } from "../lib/provider_redaction";

const STORE_AGENT_TYPE = "store_thread" as const;
const MAX_USER_MESSAGE_CHARS = 8_000;
const MAX_HISTORY_MESSAGES = 80;
const MAX_AGENT_STEPS = 10;
const MAX_CATALOG_ENTRIES = 200;
const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

type ThreadMessageRow = {
  _id: Id<"store_thread_messages">;
  ownerId: string;
  threadRef: Id<"store_threads">;
  role: Infer<typeof store_thread_message_role_validator>;
  text: string;
  attachedCommitHashes?: string[];
  draftPayload?: Infer<typeof store_thread_draft_payload_validator>;
  candidatesPayload?: Infer<typeof store_thread_candidates_payload_validator>;
  pending?: boolean;
  createdAt: number;
};

type CommitCatalogEntry = Infer<typeof store_thread_commit_validator>;

const normalizePackageId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Package ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const resolveAuthorDisplayName = (identity: {
  name?: string;
  email?: string;
}): string | undefined => {
  const name = identity.name?.trim();
  if (name) return name;
  const email = identity.email?.trim();
  if (email) {
    const local = email.split("@")[0]?.trim();
    if (local) return local;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Internal queries / mutations (used by the action below + by the agent's
// tools, which `runMutation`/`runQuery` into them).
// ---------------------------------------------------------------------------

export const getOrCreateThreadInternal = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("store_threads")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (existing) return existing;
    const now = Date.now();
    const ref = await ctx.db.insert("store_threads", {
      ownerId: args.ownerId,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(ref);
    if (!created) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to create Store thread",
      });
    }
    return created;
  },
});

// The catalog itself is not persisted on `store_threads` — the action
// arg already carries it for the live turn, and nothing reads it back
// across turns. We just stamp the timestamp the side panel uses for its
// "catalog uploaded …" hint.
export const stampCatalogUploadedInternal = internalMutation({
  args: {
    threadRef: v.id("store_threads"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.threadRef, {
      commitCatalogUploadedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const insertMessageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    threadRef: v.id("store_threads"),
    role: store_thread_message_role_validator,
    text: v.string(),
    attachedCommitHashes: v.optional(v.array(v.string())),
    draftPayload: v.optional(store_thread_draft_payload_validator),
    candidatesPayload: v.optional(store_thread_candidates_payload_validator),
    pending: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ref = await ctx.db.insert("store_thread_messages", {
      ownerId: args.ownerId,
      threadRef: args.threadRef,
      role: args.role,
      text: args.text,
      ...(args.attachedCommitHashes
        ? { attachedCommitHashes: args.attachedCommitHashes }
        : {}),
      ...(args.draftPayload ? { draftPayload: args.draftPayload } : {}),
      ...(args.candidatesPayload
        ? { candidatesPayload: args.candidatesPayload }
        : {}),
      ...(args.pending ? { pending: true } : {}),
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
    draftPayload: v.optional(store_thread_draft_payload_validator),
    candidatesPayload: v.optional(store_thread_candidates_payload_validator),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    const patch: Record<string, unknown> = {};
    if (args.text !== undefined) patch.text = args.text;
    if (args.pending !== undefined) {
      // Convex doesn't allow `undefined` patches to remove fields; explicit
      // `false` writes a no-op since the column is `optional`. To clear it,
      // re-insert without the field — but here we just stamp false and the
      // UI ignores `pending: false`.
      patch.pending = args.pending;
    }
    if (args.draftPayload !== undefined) patch.draftPayload = args.draftPayload;
    if (args.candidatesPayload !== undefined)
      patch.candidatesPayload = args.candidatesPayload;
    await ctx.db.patch(args.messageId, patch);
    return null;
  },
});

export const listMessagesInternal = internalQuery({
  args: { threadRef: v.id("store_threads") },
  handler: async (ctx, args) => {
    // Read the newest MAX_HISTORY_MESSAGES then re-sort chronologically.
    // `take` after `order("asc")` would silently drop the latest writes
    // once the thread grows past the cap, which makes new sends look
    // like nothing happened.
    const newestFirst = await ctx.db
      .query("store_thread_messages")
      .withIndex("by_threadRef_and_createdAt", (q) =>
        q.eq("threadRef", args.threadRef),
      )
      .order("desc")
      .take(MAX_HISTORY_MESSAGES);
    return newestFirst.reverse();
  },
});

export const getThreadInternal = internalQuery({
  args: { threadRef: v.id("store_threads") },
  handler: async (ctx, args) => await ctx.db.get(args.threadRef),
});

// ---------------------------------------------------------------------------
// Public surface (renderer subscribes to these).
// ---------------------------------------------------------------------------

const store_thread_message_validator = v.object({
  _id: v.id("store_thread_messages"),
  _creationTime: v.number(),
  ownerId: v.string(),
  threadRef: v.id("store_threads"),
  role: store_thread_message_role_validator,
  text: v.string(),
  attachedCommitHashes: v.optional(v.array(v.string())),
  draftPayload: v.optional(store_thread_draft_payload_validator),
  candidatesPayload: v.optional(store_thread_candidates_payload_validator),
  pending: v.optional(v.boolean()),
  createdAt: v.number(),
});

export const listMessages = query({
  args: {},
  returns: v.object({
    threadId: v.union(v.null(), v.id("store_threads")),
    messages: v.array(store_thread_message_validator),
    catalogUploadedAt: v.optional(v.number()),
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
    // Read the newest window then re-sort chronologically — same reason
    // as `listMessagesInternal`: ascending + take drops fresh writes
    // once the thread grows past MAX_HISTORY_MESSAGES.
    const newestFirst = (await ctx.db
      .query("store_thread_messages")
      .withIndex("by_threadRef_and_createdAt", (q) =>
        q.eq("threadRef", thread._id),
      )
      .order("desc")
      .take(MAX_HISTORY_MESSAGES)) as ThreadMessageRow[];
    const messages = newestFirst.reverse();
    return {
      threadId: thread._id,
      messages: messages as Array<Infer<typeof store_thread_message_validator>>,
      ...(thread.commitCatalogUploadedAt
        ? { catalogUploadedAt: thread.commitCatalogUploadedAt }
        : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// sendMessage — single agent turn.
//
// The desktop uploads the lightweight commit catalog with each send, since
// that's the only way the backend can know about local changes. The catalog
// is what the agent reasons over; full file snapshots (needed for publish)
// are uploaded later by `confirmDraft`.
// ---------------------------------------------------------------------------

const validateCatalog = (catalog: CommitCatalogEntry[]) => {
  if (catalog.length > MAX_CATALOG_ENTRIES) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Commit catalog exceeds ${MAX_CATALOG_ENTRIES} entries.`,
    });
  }
};

const buildHistoryMessages = (
  messages: ThreadMessageRow[],
): Array<Record<string, unknown>> => {
  // `draft` and `candidates` are UI-only roles persisted for the side
  // panel's state machine — the model never sees them as raw transcript
  // entries (it already saw its own tool call that produced them, and
  // the user's reaction comes back as a synthesized `user` message).
  // Filter pending placeholders too so the in-flight assistant row
  // doesn't poison the next turn's prompt.
  return messages
    .filter(
      (message) =>
        !message.pending
        && message.role !== "draft"
        && message.role !== "candidates",
    )
    .map((message) => ({
      role: message.role,
      content: [{ type: "text" as const, text: message.text }],
    }));
};

const buildStoreThreadTools = (args: {
  ctx: ActionCtx;
  ownerId: string;
  threadRef: Id<"store_threads">;
  catalog: CommitCatalogEntry[];
  pendingMessageId: Id<"store_thread_messages">;
  draftEmittedRef: { current: boolean };
  candidatesEmittedRef: { current: boolean };
}): BackendToolSet => {
  const formatJson = (value: unknown) => JSON.stringify(value ?? null, null, 2);

  const StoreListAvailableCommits: BackendToolDefinition = {
    name: "StoreListAvailableCommits",
    description:
      "Return the user's recent local change catalog (no patches; subject, body, files, timestamps). This is the same catalog summarized in the user message context — call it for the full structured listing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => formatJson(args.catalog),
  };

  const StoreListPackages: BackendToolDefinition = {
    name: "StoreListPackages",
    description:
      "List Store mods this user already owns. Use to decide whether a publish request is a new mod or an update.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async () => {
      const records = await args.ctx.runQuery(
        internal.data.store_packages.listPackagesForOwnerInternal,
        { ownerId: args.ownerId },
      );
      return formatJson(records);
    },
  };

  const StoreGetPackage: BackendToolDefinition = {
    name: "StoreGetPackage",
    description: "Load one existing Store mod by package id. Returns null if it does not exist.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        packageId: { type: "string" },
      },
      required: ["packageId"],
    },
    execute: async (input) => {
      const packageId = String(input.packageId ?? "").trim();
      if (!packageId) return "packageId is required.";
      const record = await args.ctx.runQuery(
        internal.data.store_packages.getPackageByPackageIdInternal,
        { ownerId: args.ownerId, packageId },
      );
      return formatJson(record);
    },
  };

  const StoreListPackageReleases: BackendToolDefinition = {
    name: "StoreListPackageReleases",
    description: "List the release history for one of the user's Store mods (newest first).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        packageId: { type: "string" },
      },
      required: ["packageId"],
    },
    execute: async (input) => {
      const packageId = String(input.packageId ?? "").trim();
      if (!packageId) return "packageId is required.";
      const records = await args.ctx.runQuery(
        internal.data.store_packages.listReleasesForPackageInternal,
        { ownerId: args.ownerId, packageId },
      );
      return formatJson(records);
    },
  };

  const StorePresentDraft: BackendToolDefinition = {
    name: "StorePresentDraft",
    description:
      "Surface a draft Store release for the user to confirm in the UI. Call exactly once when you're confident, then send a short follow-up message and stop. The user reviews and confirms; you do not publish yourself.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        packageId: { type: "string", description: "Stable kebab-case id (e.g. 'notes-page'). Reuse the existing id when updating." },
        category: {
          type: "string",
          enum: [
            "apps-games",
            "productivity",
            "customization",
            "skills-agents",
            "integrations",
            "other",
          ],
          description:
            "Broad browse category. Pick `skills-agents` only when the change is clearly new or modified assistant capability; `customization` for themes/layouts; `apps-games` for full apps and games; `productivity` for note-taking, todos, etc.; `integrations` for connectors; `other` when nothing else fits.",
        },
        displayName: { type: "string" },
        description: { type: "string" },
        releaseNotes: { type: "string", description: "Optional, recommended for updates." },
        commitHashes: {
          type: "array",
          items: { type: "string" },
          description: "Subset of the catalog to include in this release.",
        },
        existingPackageId: {
          type: "string",
          description: "Set when this is an update — must match an existing owned package id.",
        },
      },
      required: ["packageId", "category", "displayName", "description", "commitHashes"],
    },
    execute: async (input) => {
      if (args.draftEmittedRef.current) {
        return "A draft has already been presented this turn. Send a short follow-up message and stop.";
      }

      const requestedHashes = Array.isArray(input.commitHashes)
        ? input.commitHashes.filter((entry): entry is string => typeof entry === "string")
        : [];
      const catalogHashes = new Set(args.catalog.map((entry) => entry.commitHash));
      const filteredHashes = requestedHashes
        .map((hash) => hash.trim())
        .filter((hash) => hash.length > 0 && catalogHashes.has(hash));
      if (filteredHashes.length === 0) {
        return "StorePresentDraft failed: commitHashes must reference changes from the current catalog.";
      }

      const existingPackageIdInput =
        typeof input.existingPackageId === "string" && input.existingPackageId.trim()
          ? input.existingPackageId.trim().toLowerCase()
          : undefined;
      let normalizedExistingPackageId: string | undefined;
      let existingPackage: {
        category?:
          | "apps-games"
          | "productivity"
          | "customization"
          | "skills-agents"
          | "integrations"
          | "other";
        displayName: string;
        description: string;
        latestReleaseNumber: number;
      } | null = null;
      if (existingPackageIdInput) {
        try {
          normalizedExistingPackageId = normalizePackageId(existingPackageIdInput);
        } catch (error) {
          return `StorePresentDraft failed: ${(error as Error).message}`;
        }
        const record = await args.ctx.runQuery(
          internal.data.store_packages.getPackageByPackageIdInternal,
          { ownerId: args.ownerId, packageId: normalizedExistingPackageId },
        );
        if (!record) {
          return `StorePresentDraft failed: existing package "${normalizedExistingPackageId}" not found.`;
        }
        existingPackage = {
          ...(record.category ? { category: record.category } : {}),
          displayName: record.displayName,
          description: record.description,
          latestReleaseNumber: record.latestReleaseNumber,
        };
      }

      let normalizedPackageId: string;
      try {
        normalizedPackageId =
          normalizedExistingPackageId ?? normalizePackageId(String(input.packageId ?? ""));
      } catch (error) {
        return `StorePresentDraft failed: ${(error as Error).message}`;
      }

      const category: StorePackageCategory = existingPackage?.category
        ? normalizeStoreCategory(existingPackage.category)
        : normalizeStoreCategory(String(input.category ?? "stella"));
      const displayName =
        existingPackage?.displayName ?? String(input.displayName ?? "").trim();
      const description =
        existingPackage?.description ?? String(input.description ?? "").trim();
      if (!displayName || !description) {
        return "StorePresentDraft failed: displayName and description are required for new mods.";
      }
      const releaseNumber = existingPackage
        ? existingPackage.latestReleaseNumber + 1
        : 1;
      const releaseNotes =
        typeof input.releaseNotes === "string" && input.releaseNotes.trim()
          ? input.releaseNotes.trim()
          : undefined;

      const commitByHash = new Map(args.catalog.map((entry) => [entry.commitHash, entry]));
      const selectedChanges = filteredHashes
        .map((hash) => {
          const commit = commitByHash.get(hash);
          if (!commit) return null;
          return {
            commitHash: commit.commitHash,
            shortHash: commit.shortHash,
            subject: commit.subject,
            files: commit.files,
          };
        })
        .filter((entry): entry is {
          commitHash: string;
          shortHash: string;
          subject: string;
          files: string[];
        } => entry !== null);

      const draftPayload: Infer<typeof store_thread_draft_payload_validator> = {
        packageId: normalizedPackageId,
        category,
        displayName,
        description,
        ...(releaseNotes ? { releaseNotes } : {}),
        releaseNumber,
        ...(normalizedExistingPackageId
          ? { existingPackageId: normalizedExistingPackageId }
          : {}),
        commitHashes: filteredHashes,
        selectedChanges,
      };

      await args.ctx.runMutation(
        internal.data.store_thread.insertMessageInternal,
        {
          ownerId: args.ownerId,
          threadRef: args.threadRef,
          role: "draft",
          text: "",
          draftPayload,
        },
      );
      args.draftEmittedRef.current = true;

      return "Draft presented to the user. Now send one short message telling them to confirm, then stop.";
    },
  };

  const StorePresentCandidates: BackendToolDefinition = {
    name: "StorePresentCandidates",
    description:
      "Surface a multi-pick checklist of candidate commits when more than one set of changes could plausibly belong to this publish. The user picks via the side panel and their selection comes back as a normal user message. Call this instead of `StorePresentDraft` when grouping is genuinely ambiguous; otherwise prefer `StorePresentDraft` directly.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: {
          type: "string",
          description:
            "One short sentence shown above the checklist explaining why you're asking the user to pick (e.g. 'Pick the changes that belong to the snake game update').",
        },
        commitHashes: {
          type: "array",
          items: { type: "string" },
          description:
            "Candidate commit hashes from the current catalog. The user will pick a subset.",
        },
      },
      required: ["reason", "commitHashes"],
    },
    execute: async (input) => {
      if (args.candidatesEmittedRef.current) {
        return "A candidate list has already been presented this turn. Send a short follow-up message and stop.";
      }
      const reason = String(input.reason ?? "").trim();
      if (!reason) {
        return "StorePresentCandidates failed: reason is required.";
      }
      const requestedHashes = Array.isArray(input.commitHashes)
        ? input.commitHashes.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const catalogHashes = new Set(args.catalog.map((entry) => entry.commitHash));
      const filteredHashes = Array.from(
        new Set(
          requestedHashes
            .map((hash) => hash.trim())
            .filter((hash) => hash.length > 0 && catalogHashes.has(hash)),
        ),
      );
      if (filteredHashes.length < 2) {
        return "StorePresentCandidates failed: include at least 2 catalog hashes; for a single match call StorePresentDraft directly.";
      }
      await args.ctx.runMutation(
        internal.data.store_thread.insertMessageInternal,
        {
          ownerId: args.ownerId,
          threadRef: args.threadRef,
          role: "candidates",
          text: "",
          candidatesPayload: {
            reason,
            commitHashes: filteredHashes,
          },
        },
      );
      args.candidatesEmittedRef.current = true;
      return "Candidate checklist presented. Stop now and wait for the user's pick.";
    },
  };

  return {
    StoreListAvailableCommits,
    StoreListPackages,
    StoreGetPackage,
    StoreListPackageReleases,
    StorePresentDraft,
    StorePresentCandidates,
  };
};

const runStoreThreadAgent = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  threadRef: Id<"store_threads">;
  catalog: CommitCatalogEntry[];
  history: ThreadMessageRow[];
  attachedCommitHashes: string[];
  userText: string;
  pendingMessageId: Id<"store_thread_messages">;
}): Promise<{
  assistantText: string;
  draftEmitted: boolean;
  candidatesEmitted: boolean;
}> => {
  const access = await assertManagedUsageAllowed(args.ctx, args.ownerId);
  const resolvedConfig = await resolveModelConfig(
    args.ctx,
    STORE_AGENT_TYPE,
    args.ownerId,
    { access },
  );
  const fallbackConfig = await resolveFallbackConfig(
    args.ctx,
    STORE_AGENT_TYPE,
    args.ownerId,
    { access },
  );

  const draftEmittedRef = { current: false };
  const candidatesEmittedRef = { current: false };
  const tools = buildStoreThreadTools({
    ctx: args.ctx,
    ownerId: args.ownerId,
    threadRef: args.threadRef,
    catalog: args.catalog,
    pendingMessageId: args.pendingMessageId,
    draftEmittedRef,
    candidatesEmittedRef,
  });

  const historyMessages = buildHistoryMessages(args.history);

  // Inject the catalog summary + user text as the latest user turn in the
  // request. The persisted user message stores only the user's plain text;
  // the catalog is regenerated server-side per turn so the model always
  // sees the current upload.
  const openingUserText = buildStoreThreadOpeningUserMessage({
    catalogContext: buildStoreThreadCatalogContext(args.catalog),
    attachedCommitHashes: args.attachedCommitHashes.length > 0
      ? args.attachedCommitHashes
      : undefined,
    userText: args.userText,
  });

  // Replace the most recent persisted user turn with the enriched copy so
  // the model sees catalog context inline. (History already excludes the
  // pending assistant placeholder via `pending` filter.)
  const trimmedHistory = historyMessages.slice(0, -1);
  const enrichedMessages = [
    ...trimmedHistory,
    { role: "user" as const, content: [{ type: "text" as const, text: openingUserText }] },
  ];

  const startedAt = Date.now();
  const result = await streamTextWithFailover({
    resolvedConfig,
    fallbackConfig,
    sharedArgs: {
      system: STORE_THREAD_SYSTEM_PROMPT,
      tools,
      maxSteps: MAX_AGENT_STEPS,
      messages: enrichedMessages,
    } as Record<string, unknown>,
  });

  const text = scrubProviderTerms((await result.text) ?? "");
  const totalUsage = await result.totalUsage;
  const usageByModel = await result.usageByModel;
  const durationMs = Date.now() - startedAt;
  const perModel = splitDurationAcrossModels(usageByModel, durationMs);
  if (perModel.length > 0) {
    for (const entry of perModel) {
      await scheduleManagedUsage(args.ctx, {
        ownerId: args.ownerId,
        agentType: STORE_AGENT_TYPE,
        model: entry.model,
        durationMs: entry.durationMs,
        success: true,
        usage: entry.usage,
      });
    }
  } else {
    await scheduleManagedUsage(args.ctx, {
      ownerId: args.ownerId,
      agentType: STORE_AGENT_TYPE,
      model: result.executedModel,
      durationMs,
      success: true,
      usage: usageSummaryFromFinish(totalUsage),
    });
  }

  return {
    assistantText: text,
    draftEmitted: draftEmittedRef.current,
    candidatesEmitted: candidatesEmittedRef.current,
  };
};

export const sendMessage = action({
  args: {
    text: v.string(),
    attachedCommitHashes: v.optional(v.array(v.string())),
    commitCatalog: v.array(store_thread_commit_validator),
  },
  returns: v.object({
    threadId: v.id("store_threads"),
    userMessageId: v.id("store_thread_messages"),
    assistantMessageId: v.id("store_thread_messages"),
  }),
  handler: async (ctx, args): Promise<{
    threadId: Id<"store_threads">;
    userMessageId: Id<"store_thread_messages">;
    assistantMessageId: Id<"store_thread_messages">;
  }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    const ownerId = identity.tokenIdentifier;
    await enforceActionRateLimit(
      ctx,
      "store_thread_send_message",
      ownerId,
      RATE_HOT_PATH,
      "Too many Store messages. Please wait a moment and try again.",
    );

    const userText = args.text.trim();
    if (!userText && (args.attachedCommitHashes?.length ?? 0) === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Add a message or attach at least one change.",
      });
    }
    if (userText.length > MAX_USER_MESSAGE_CHARS) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Message exceeds ${MAX_USER_MESSAGE_CHARS} characters.`,
      });
    }

    validateCatalog(args.commitCatalog);

    const thread = await ctx.runMutation(
      internal.data.store_thread.getOrCreateThreadInternal,
      { ownerId },
    );
    await ctx.runMutation(
      internal.data.store_thread.stampCatalogUploadedInternal,
      { threadRef: thread._id },
    );

    const attachedHashes = (args.attachedCommitHashes ?? [])
      .map((hash) => hash.trim())
      .filter(Boolean);
    const userMessageId = await ctx.runMutation(
      internal.data.store_thread.insertMessageInternal,
      {
        ownerId,
        threadRef: thread._id,
        role: "user",
        text: userText,
        ...(attachedHashes.length > 0
          ? { attachedCommitHashes: attachedHashes }
          : {}),
      },
    );
    const assistantMessageId = await ctx.runMutation(
      internal.data.store_thread.insertMessageInternal,
      {
        ownerId,
        threadRef: thread._id,
        role: "assistant",
        text: "",
        pending: true,
      },
    );

    const history = (await ctx.runQuery(
      internal.data.store_thread.listMessagesInternal,
      { threadRef: thread._id },
    )) as ThreadMessageRow[];

    let assistantText = "";
    try {
      const result = await runStoreThreadAgent({
        ctx,
        ownerId,
        threadRef: thread._id,
        catalog: args.commitCatalog,
        history,
        attachedCommitHashes: attachedHashes,
        userText,
        pendingMessageId: assistantMessageId,
      });
      assistantText = result.assistantText.trim();
      if (
        !assistantText
        && !result.draftEmitted
        && !result.candidatesEmitted
      ) {
        assistantText = "Done.";
      }
    } catch (error) {
      assistantText = `Sorry — I couldn't finish that. ${(error as Error)?.message ?? ""}`.trim();
    }

    await ctx.runMutation(internal.data.store_thread.patchMessageInternal, {
      messageId: assistantMessageId,
      text: assistantText,
      pending: false,
    });

    return {
      threadId: thread._id,
      userMessageId,
      assistantMessageId,
    };
  },
});

// ---------------------------------------------------------------------------
// confirmDraft — direct publish (no LLM round-trip).
//
// Desktop builds the full bundle (with file snapshots) for the picked
// commits at confirm time and ships it inline. Backend writes the package
// + release rows and stamps the draft message as published.
// ---------------------------------------------------------------------------

const candidate_commit_validator = v.object({
  commitHash: v.string(),
  shortHash: v.optional(v.string()),
  subject: v.string(),
  body: v.string(),
  timestampMs: v.optional(v.number()),
  files: v.array(v.string()),
  patch: v.string(),
});

const candidate_file_validator = v.object({
  path: v.string(),
  deleted: v.boolean(),
  contentBase64: v.optional(v.string()),
});

const PARENT_TRAILER_REGEX = /^Stella-Parent-Package-Id:\s*(.+)$/gm;

/**
 * Walk every commit body in the publish bundle and union the
 * `Stella-Parent-Package-Id` trailers, then resolve each parent slug
 * against the user's installed add-ons to capture which release was
 * being extended at commit time.
 *
 * Resolution rules (per parent slug):
 *   - If the user has the package installed -> use that install's
 *     `releaseNumber` as `compatibleWithReleaseNumber`.
 *   - If they don't (rare; the install may have been removed since the
 *     commit), look up the latest release of the package globally.
 *   - If neither is available, drop the entry rather than guessing.
 *
 * `authorHandle` is left as the `packageId` slug for now; once
 * `user_profiles` lands (Phase 5) the resolver fills the real handle.
 */
const resolveParentRefsForPublish = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    commits: Array<Infer<typeof candidate_commit_validator>>;
    /**
     * Snapshot of the user's currently installed release for each
     * referenced parent slug, captured by the desktop at confirm time.
     * Always preferred over a fresh "latest" lookup so the manifest
     * records the version the change was actually authored against.
     */
    installedParents?: Array<{ packageId: string; releaseNumber: number }>;
  },
): Promise<Array<{
  authorHandle: string;
  packageId: string;
  compatibleWithReleaseNumber: number;
}>> => {
  const slugs = new Set<string>();
  for (const commit of args.commits) {
    const matches = commit.body.matchAll(PARENT_TRAILER_REGEX);
    for (const match of matches) {
      const slug = match[1]?.trim().toLowerCase();
      if (slug) slugs.add(slug);
    }
  }
  if (slugs.size === 0) return [];

  // Index the desktop-supplied install snapshot for O(1) lookup.
  const installedReleaseBySlug = new Map<string, number>();
  for (const entry of args.installedParents ?? []) {
    const slug = entry.packageId?.trim().toLowerCase();
    if (slug && Number.isFinite(entry.releaseNumber)) {
      installedReleaseBySlug.set(slug, entry.releaseNumber);
    }
  }

  const refs: Array<{
    authorHandle: string;
    packageId: string;
    compatibleWithReleaseNumber: number;
  }> = [];
  for (const slug of slugs) {
    let releaseNumber: number | null = installedReleaseBySlug.get(slug) ?? null;
    let resolvedOwnerId: string | null = null;

    // Even when the installed snapshot already pinned the release
    // number, fetch the package row to recover `resolvedOwnerId` so we
    // can stamp the real `authorHandle` instead of the bare slug.
    try {
      const ownInstall = await ctx.runQuery(
        internal.data.store_packages.getPackageByPackageIdInternal,
        { ownerId: args.ownerId, packageId: slug },
      );
      if (ownInstall) {
        if (releaseNumber == null) {
          releaseNumber = ownInstall.latestReleaseNumber;
        }
        resolvedOwnerId = ownInstall.ownerId;
      }
    } catch {
      // ignore — fall through to the cross-owner lookup
    }

    // Cross-creator extensions: the parent slug points at someone
    // else's published add-on. The package row gives us the original
    // owner (for the handle lookup) and a last-resort release number
    // when the desktop didn't ship an install snapshot.
    if (resolvedOwnerId == null) {
      try {
        const anyPkg = await ctx.runQuery(
          internal.data.store_packages.getAnyPackageByPackageIdInternal,
          { packageId: slug },
        );
        if (anyPkg) {
          if (releaseNumber == null) {
            releaseNumber = anyPkg.latestReleaseNumber;
          }
          resolvedOwnerId = anyPkg.ownerId;
        }
      } catch {
        // soft-fail; nothing else to try
      }
    }

    if (releaseNumber == null) continue;

    let authorHandle = slug;
    if (resolvedOwnerId) {
      try {
        const handle = await ctx.runQuery(
          internal.data.user_profiles.getHandleForOwnerInternal,
          { ownerId: resolvedOwnerId },
        );
        if (handle) authorHandle = handle;
      } catch {
        // soft-fail; fall back to the slug
      }
    }
    refs.push({
      authorHandle,
      packageId: slug,
      compatibleWithReleaseNumber: releaseNumber,
    });
  }
  return refs;
};

const buildBundle = (args: {
  draft: Infer<typeof store_thread_draft_payload_validator>;
  commits: Array<Infer<typeof candidate_commit_validator>>;
  files: Array<Infer<typeof candidate_file_validator>>;
}): StorePublishCandidateBundle => ({
  requestText: `Confirmed publish for ${args.draft.displayName}`,
  selectedCommitHashes: args.draft.commitHashes,
  commits: args.commits.map((commit) => ({
    commitHash: commit.commitHash.trim(),
    ...(commit.shortHash ? { shortHash: commit.shortHash.trim() } : {}),
    subject: commit.subject.trim() || "Stella update",
    body: commit.body,
    ...(typeof commit.timestampMs === "number"
      ? { timestampMs: commit.timestampMs }
      : {}),
    files: commit.files.map((file) => file.trim()).filter(Boolean),
    patch: commit.patch,
  })),
  files: args.files.map((file) => ({
    path: file.path.trim(),
    deleted: file.deleted,
    ...(file.contentBase64 ? { contentBase64: file.contentBase64 } : {}),
  })),
  ...(args.draft.existingPackageId
    ? { existingPackageId: args.draft.existingPackageId }
    : {}),
});

export const confirmDraft = action({
  args: {
    draftMessageId: v.id("store_thread_messages"),
    commits: v.array(candidate_commit_validator),
    files: v.array(candidate_file_validator),
    /**
     * Optional `Stella` HEAD captured by the desktop at confirm time -
     * stamped onto the release's `authoredAgainst.stellaCommit` hint.
     * Older runtimes don't send it; the install agent treats it as
     * best-effort.
     */
    stellaCommit: v.optional(v.string()),
    /**
     * Snapshot of the user's currently installed release for each
     * parent add-on referenced by `Stella-Parent-Package-Id` trailers.
     * Lets `resolveParentRefsForPublish` stamp the release the change
     * was actually authored against (rather than the parent's current
     * latest, which may have moved on while the user worked).
     */
    installedParents: v.optional(
      v.array(
        v.object({
          packageId: v.string(),
          releaseNumber: v.number(),
        }),
      ),
    ),
  },
  returns: v.object({
    releaseNumber: v.number(),
    packageId: v.string(),
  }),
  handler: async (ctx, args): Promise<{ releaseNumber: number; packageId: string }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    const ownerId = identity.tokenIdentifier;
    await enforceActionRateLimit(
      ctx,
      "store_thread_confirm_draft",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many Store publishes. Please wait before publishing again.",
    );

    const message = (await ctx.runQuery(
      internal.data.store_thread.getMessageInternal,
      { messageId: args.draftMessageId },
    )) as (ThreadMessageRow & { _creationTime: number }) | null;
    if (!message || message.ownerId !== ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Draft not found." });
    }
    if (message.role !== "draft" || !message.draftPayload) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Message is not a draft.",
      });
    }
    if (message.draftPayload.publishedAt || message.draftPayload.cancelledAt) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Draft has already been resolved.",
      });
    }

    // Reject confirmations whose uploaded bundle does not match the
    // exact set of commits the user reviewed. The renderer is
    // user-modifiable, so a stale or tampered client could otherwise
    // confirm a draft for one selection while uploading a different
    // bundle — the published artifact must always equal what the draft
    // card showed.
    const expectedCommitHashes = new Set(message.draftPayload.commitHashes);
    const submittedCommitHashes = new Set(
      args.commits.map((commit) => commit.commitHash),
    );
    const missing: string[] = [];
    for (const expected of expectedCommitHashes) {
      if (!submittedCommitHashes.has(expected)) missing.push(expected);
    }
    const extra: string[] = [];
    for (const submitted of submittedCommitHashes) {
      if (!expectedCommitHashes.has(submitted)) extra.push(submitted);
    }
    if (missing.length > 0 || extra.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(`missing ${missing.length} commit(s) from the draft`);
      }
      if (extra.length > 0) {
        parts.push(`includes ${extra.length} commit(s) not in the draft`);
      }
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Bundle does not match the draft (${parts.join("; ")}).`,
      });
    }

    const bundle = buildBundle({
      draft: message.draftPayload,
      commits: args.commits,
      files: args.files,
    });

    const iconUrl =
      (await generateStoreIconUrl({
        displayName: message.draftPayload.displayName,
        description: message.draftPayload.description,
        category: message.draftPayload.category,
      })) || undefined;
    const authorDisplayName = resolveAuthorDisplayName({
      ...(typeof identity.name === "string" ? { name: identity.name } : {}),
      ...(typeof identity.email === "string" ? { email: identity.email } : {}),
    });
    // The package row's `authorHandle` is resolved server-side inside
    // `createFirstRelease` / `createUpdateRelease` directly from
    // `user_profiles`, so we no longer pre-fetch it here.

    // Resolve parent add-on references from the bundle's commit
    // bodies. Each commit may carry one or more `Stella-Parent-Package-Id`
    // trailers; we union them across the publish, then look up each one
    // against the user's installed add-ons to capture the release
    // number that was being extended.
    const parentRefs = await resolveParentRefsForPublish(ctx, {
      ownerId,
      commits: args.commits,
      ...(args.installedParents
        ? { installedParents: args.installedParents }
        : {}),
    });
    const authoredAgainst = args.stellaCommit
      ? { stellaCommit: args.stellaCommit }
      : undefined;

    const artifact = buildStoreReleaseArtifactFromCandidate({
      packageId: message.draftPayload.packageId,
      releaseNumber: message.draftPayload.releaseNumber,
      category: message.draftPayload.category,
      displayName: message.draftPayload.displayName,
      description: message.draftPayload.description,
      ...(message.draftPayload.releaseNotes
        ? { releaseNotes: message.draftPayload.releaseNotes }
        : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(authorDisplayName ? { authorDisplayName } : {}),
      ...(parentRefs.length > 0 ? { parent: parentRefs } : {}),
      ...(authoredAgainst ? { authoredAgainst } : {}),
      candidate: bundle,
    });

    const manifestArgs = {
      includedBatchIds: artifact.manifest.batchIds,
      includedCommitHashes: artifact.manifest.commitHashes,
      changedFiles: artifact.manifest.files,
      category: message.draftPayload.category,
      ...(artifact.manifest.releaseNotes
        ? { summary: artifact.manifest.releaseNotes }
        : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(authorDisplayName ? { authorDisplayName } : {}),
      ...(parentRefs.length > 0 ? { parent: parentRefs } : {}),
      ...(authoredAgainst ? { authoredAgainst } : {}),
    };

    // `createFirstRelease` / `createUpdateRelease` resolve the caller's
    // `authorHandle` server-side from `user_profiles`, so we don't pass
    // it here — the renderer can't impersonate another creator.
    const result = message.draftPayload.existingPackageId
      ? await ctx.runAction(api.data.store_packages.createUpdateRelease, {
          packageId: message.draftPayload.packageId,
          ...(message.draftPayload.releaseNotes
            ? { releaseNotes: message.draftPayload.releaseNotes }
            : {}),
          manifest: manifestArgs,
          artifactBody: JSON.stringify(artifact),
          artifactContentType: "application/json",
        })
      : await ctx.runAction(api.data.store_packages.createFirstRelease, {
          packageId: message.draftPayload.packageId,
          category: message.draftPayload.category,
          displayName: message.draftPayload.displayName,
          description: message.draftPayload.description,
          ...(message.draftPayload.releaseNotes
            ? { releaseNotes: message.draftPayload.releaseNotes }
            : {}),
          manifest: manifestArgs,
          artifactBody: JSON.stringify(artifact),
          artifactContentType: "application/json",
        });

    await ctx.runMutation(internal.data.store_thread.patchMessageInternal, {
      messageId: args.draftMessageId,
      draftPayload: {
        ...message.draftPayload,
        publishedAt: Date.now(),
        publishedReleaseNumber: result.release.releaseNumber,
      },
    });
    await ctx.runMutation(
      internal.data.store_thread.insertMessageInternal,
      {
        ownerId,
        threadRef: message.threadRef,
        role: "assistant",
        text: `Published ${result.package.displayName} v${result.release.releaseNumber}.`,
      },
    );

    return {
      releaseNumber: result.release.releaseNumber,
      packageId: result.package.packageId,
    };
  },
});

export const cancelDraft = mutation({
  args: { draftMessageId: v.id("store_thread_messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "store_thread_cancel_draft",
      ownerId,
      RATE_HOT_PATH,
    );
    const message = await ctx.db.get(args.draftMessageId);
    if (!message || message.ownerId !== ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Draft not found." });
    }
    if (message.role !== "draft" || !message.draftPayload) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Message is not a draft.",
      });
    }
    if (message.draftPayload.publishedAt || message.draftPayload.cancelledAt) {
      return null;
    }
    await ctx.db.patch(args.draftMessageId, {
      draftPayload: {
        ...message.draftPayload,
        cancelledAt: Date.now(),
      },
    });
    return null;
  },
});

/**
 * User-driven pick after a `StorePresentCandidates` row. Stamps the
 * candidates payload with `resolvedAt` / `resolvedCommitHashes`, writes a
 * synthesized user message describing the pick, and schedules the next
 * agent turn so the agent can drop straight into `StorePresentDraft`.
 *
 * The mutation itself is cheap; the heavy lifting happens in the
 * scheduled action. This keeps the renderer's submit-pick path
 * snappy + keeps the state-machine derivation honest (a pending
 * assistant row appears immediately).
 */
export const submitCandidatesPick = mutation({
  args: {
    candidatesMessageId: v.id("store_thread_messages"),
    pickedCommitHashes: v.array(v.string()),
    commitCatalog: v.array(store_thread_commit_validator),
  },
  returns: v.object({
    userMessageId: v.id("store_thread_messages"),
    assistantMessageId: v.id("store_thread_messages"),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    userMessageId: Id<"store_thread_messages">;
    assistantMessageId: Id<"store_thread_messages">;
  }> => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "store_thread_submit_candidates_pick",
      ownerId,
      RATE_HOT_PATH,
    );
    validateCatalog(args.commitCatalog);

    const message = await ctx.db.get(args.candidatesMessageId);
    if (!message || message.ownerId !== ownerId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Candidates message not found.",
      });
    }
    if (message.role !== "candidates" || !message.candidatesPayload) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Message is not a candidate list.",
      });
    }
    if (message.candidatesPayload.resolvedAt) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Candidate list has already been resolved.",
      });
    }

    const candidateSet = new Set(message.candidatesPayload.commitHashes);
    const picked = Array.from(
      new Set(
        args.pickedCommitHashes
          .map((hash) => hash.trim())
          .filter((hash) => hash.length > 0 && candidateSet.has(hash)),
      ),
    );
    if (picked.length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Pick at least one of the suggested changes.",
      });
    }

    await ctx.db.patch(args.candidatesMessageId, {
      candidatesPayload: {
        ...message.candidatesPayload,
        resolvedAt: Date.now(),
        resolvedCommitHashes: picked,
      },
    });

    // Build a short, normie-friendly user message describing the pick.
    // The catalog gives us human subjects per hash; fall back to short
    // hashes when the entry isn't in the catalog (rare).
    const subjectByHash = new Map(
      args.commitCatalog.map((entry) => [entry.commitHash, entry.subject]),
    );
    const lines: string[] = ["I picked these changes:"];
    for (const hash of picked) {
      const subject = subjectByHash.get(hash) ?? hash.slice(0, 12);
      lines.push(`- ${subject}`);
    }

    const now = Date.now();
    const userMessageRef = await ctx.db.insert("store_thread_messages", {
      ownerId,
      threadRef: message.threadRef,
      role: "user",
      text: lines.join("\n"),
      attachedCommitHashes: picked,
      createdAt: now,
    });
    const assistantMessageRef = await ctx.db.insert(
      "store_thread_messages",
      {
        ownerId,
        threadRef: message.threadRef,
        role: "assistant",
        text: "",
        pending: true,
        createdAt: now,
      },
    );
    await ctx.db.patch(message.threadRef, { updatedAt: now });

    await ctx.scheduler.runAfter(
      0,
      internal.data.store_thread.runFollowUpTurnInternal,
      {
        ownerId,
        threadRef: message.threadRef,
        assistantMessageId: assistantMessageRef,
        userText: lines.join("\n"),
        attachedCommitHashes: picked,
        commitCatalog: args.commitCatalog,
      },
    );

    return {
      userMessageId: userMessageRef,
      assistantMessageId: assistantMessageRef,
    };
  },
});

/**
 * Internal action that drives the next agent turn after a candidate
 * pick. Mirrors the body of `sendMessage` (catalog upload + agent
 * loop + final patch on the pending assistant row) but without
 * re-inserting the user/pending rows (the mutation already did).
 */
export const runFollowUpTurnInternal = internalAction({
  args: {
    ownerId: v.string(),
    threadRef: v.id("store_threads"),
    assistantMessageId: v.id("store_thread_messages"),
    userText: v.string(),
    attachedCommitHashes: v.array(v.string()),
    commitCatalog: v.array(store_thread_commit_validator),
  },
  handler: async (ctx, args): Promise<null> => {
    await ctx.runMutation(
      internal.data.store_thread.stampCatalogUploadedInternal,
      { threadRef: args.threadRef },
    );
    const history = (await ctx.runQuery(
      internal.data.store_thread.listMessagesInternal,
      { threadRef: args.threadRef },
    )) as ThreadMessageRow[];

    let assistantText = "";
    try {
      const result = await runStoreThreadAgent({
        ctx,
        ownerId: args.ownerId,
        threadRef: args.threadRef,
        catalog: args.commitCatalog,
        history,
        attachedCommitHashes: args.attachedCommitHashes,
        userText: args.userText,
        pendingMessageId: args.assistantMessageId,
      });
      assistantText = result.assistantText.trim();
      if (
        !assistantText
        && !result.draftEmitted
        && !result.candidatesEmitted
      ) {
        assistantText = "Done.";
      }
    } catch (error) {
      assistantText = `Sorry — I couldn't finish that. ${(error as Error)?.message ?? ""}`.trim();
    }

    await ctx.runMutation(internal.data.store_thread.patchMessageInternal, {
      messageId: args.assistantMessageId,
      text: assistantText,
      pending: false,
    });
    return null;
  },
});

// Internal helper used by `confirmDraft` (action ctx → query for the draft).
export const getMessageInternal = internalQuery({
  args: { messageId: v.id("store_thread_messages") },
  handler: async (ctx, args) => await ctx.db.get(args.messageId),
});
