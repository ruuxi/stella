import {
  action,
  mutation,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireConversationOwnerAction, requireUserId } from "./auth";
import { buildSystemPrompt } from "./agent/prompt_builder";
import {
  PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
  buildPersonalizedDashboardPageUserMessage,
  type PersonalizedDashboardPageAssignment,
} from "./prompts/personalized_dashboard";

const CORE_MEMORY_KEY = "core_memory";
const PAGE_MONITOR_INTERVAL_MS = 2_500;
const PAGE_RETRY_DELAY_MS = 1_500;
const PAGE_MAX_RETRIES = 2;
const TASK_CHECKIN_INTERVAL_MS = 10 * 60 * 1000;
const PANEL_WRITE_SCAN_LIMIT = 1000;

const dashboardPageStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("failed"),
);

const dashboardPageRecordValidator = v.object({
  _id: v.id("dashboard_pages"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  pageId: v.string(),
  panelName: v.string(),
  title: v.string(),
  topic: v.string(),
  focus: v.string(),
  dataSources: v.array(v.string()),
  status: dashboardPageStatusValidator,
  order: v.number(),
  taskId: v.optional(v.id("tasks")),
  retryCount: v.number(),
  statusText: v.optional(v.string()),
  lastError: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
  claimedAt: v.optional(v.number()),
  claimedBy: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
});

const plannedPageValidator = v.object({
  pageId: v.string(),
  panelName: v.string(),
  title: v.string(),
  topic: v.string(),
  focus: v.string(),
  dataSources: v.array(v.string()),
  order: v.number(),
});

const pageAssignmentInputValidator = v.object({
  pageId: v.optional(v.string()),
  title: v.string(),
  topic: v.string(),
  focus: v.string(),
  dataSources: v.optional(v.array(v.string())),
});

const sidebarPageValidator = v.object({
  pageId: v.string(),
  panelName: v.string(),
  title: v.string(),
  status: dashboardPageStatusValidator,
  order: v.number(),
  statusText: v.optional(v.string()),
  lastError: v.optional(v.string()),
});

const startGenerationResultValidator = v.object({
  started: v.boolean(),
  pageIds: v.array(v.string()),
  skippedReason: v.optional(v.string()),
});

type DashboardPageStatus = "queued" | "running" | "ready" | "failed";

type PlannedPage = {
  pageId: string;
  panelName: string;
  title: string;
  topic: string;
  focus: string;
  dataSources: string[];
  order: number;
};

type PageTemplate = {
  id: string;
  title: string;
  topic: string;
  focus: string;
  tags: string[];
  dataSources: string[];
};

const PAGE_TEMPLATES: PageTemplate[] = [
  {
    id: "tech_feed",
    title: "Tech Feed",
    topic: "Latest engineering and developer ecosystem updates",
    focus:
      "Curate high-signal software engineering updates and surface context-aware follow-up actions.",
    tags: ["developer", "engineering", "software"],
    dataSources: [
      "Hacker News API",
      "GitHub trending feeds",
      "Lobsters RSS",
      "Reddit /r/programming JSON",
    ],
  },
  {
    id: "projects_overview",
    title: "Projects",
    topic: "Active project momentum and repo health",
    focus:
      "Track project activity, top open issues, recent commits, and suggest next concrete actions.",
    tags: ["developer", "builder", "project"],
    dataSources: [
      "GitHub public APIs",
      "GitHub Atom feeds",
      "Open source status pages",
    ],
  },
  {
    id: "dev_tools",
    title: "Dev Tools",
    topic: "Tooling releases and platform status",
    focus:
      "Summarize major tooling releases, outages, and ecosystem changes relevant to day-to-day coding.",
    tags: ["developer", "devops", "infra"],
    dataSources: [
      "npm RSS feeds",
      "GitHub releases feeds",
      "Public status pages",
      "Hacker News API",
    ],
  },
  {
    id: "ai_research",
    title: "AI Research",
    topic: "Applied AI papers and model ecosystem updates",
    focus:
      "Highlight practical model/paper updates and provide short actionable summaries.",
    tags: ["ai", "research", "developer"],
    dataSources: ["HuggingFace papers", "arXiv RSS", "Papers with Code RSS"],
  },
  {
    id: "music_news",
    title: "Music News",
    topic: "Music industry and artist updates",
    focus:
      "Show fresh music updates tailored to the user's genres and artists when inferable.",
    tags: ["music", "musician", "artist"],
    dataSources: ["Music publication RSS feeds", "Wikipedia featured content", "Reddit music JSON"],
  },
  {
    id: "practice_tracker",
    title: "Practice Tracker",
    topic: "Daily/weekly practice momentum",
    focus:
      "Provide a lightweight, interactive practice tracker with suggestions the user can ask Stella to expand.",
    tags: ["music", "habit", "practice"],
    dataSources: ["Wikipedia random music topics", "Public metronome/tempo references"],
  },
  {
    id: "gear_watch",
    title: "Gear",
    topic: "Instrument and production gear updates",
    focus:
      "Track new gear announcements, availability chatter, and notable reviews from public feeds.",
    tags: ["music", "producer", "hardware"],
    dataSources: ["Retail/public gear RSS feeds", "Reddit gear JSON", "YouTube channel RSS"],
  },
  {
    id: "learning_brief",
    title: "Learning Brief",
    topic: "Curated learning and skill-growth feed",
    focus:
      "Deliver concise, practical learning items tied to the user's goals and interests.",
    tags: ["learning", "student", "general"],
    dataSources: ["Wikipedia featured feed", "Open course RSS", "Public blog RSS"],
  },
  {
    id: "world_briefing",
    title: "World Briefing",
    topic: "High-level daily global briefing",
    focus:
      "Surface concise, reliable world updates with quick jump-off actions for Stella.",
    tags: ["news", "general"],
    dataSources: ["Reuters RSS", "AP RSS", "Wikipedia current events"],
  },
];

const TAG_KEYWORDS: Record<string, string[]> = {
  developer: [
    "developer",
    "engineer",
    "software",
    "coding",
    "programming",
    "typescript",
    "javascript",
    "python",
    "github",
    "devops",
    "backend",
    "frontend",
  ],
  engineering: ["engineering", "architecture", "systems"],
  software: ["software", "app", "application", "product"],
  builder: ["build", "startup", "founder", "ship"],
  project: ["project", "repo", "repository", "issue", "sprint"],
  devops: ["infra", "kubernetes", "docker", "aws", "cloud"],
  infra: ["infrastructure", "platform", "sre", "ops"],
  ai: ["ai", "machine learning", "llm", "model", "neural", "ml"],
  research: ["research", "papers", "arxiv", "experiments"],
  music: ["music", "musician", "song", "album", "artist", "band", "playlist"],
  musician: ["guitar", "piano", "vocal", "drums", "instrument"],
  artist: ["producer", "dj", "composer", "recording"],
  habit: ["routine", "habit", "practice", "daily"],
  practice: ["practice", "rehearsal", "train"],
  producer: ["mix", "master", "daw", "ableton", "fl studio"],
  hardware: ["gear", "synth", "pedal", "microphone", "headphones"],
  learning: ["learn", "study", "course", "skill", "reading"],
  student: ["student", "school", "university", "college"],
  news: ["news", "briefing", "world", "headlines", "current events"],
  general: ["hobby", "interests", "lifestyle"],
};

const DEFAULT_TEMPLATE_IDS = ["learning_brief", "world_briefing", "tech_feed"];

const normalizeText = (value: string, maxLength: number) =>
  value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

const toLowerPath = (value: string) => value.replace(/\\/g, "/").toLowerCase();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const didTaskWritePanelFile = async (
  ctx: ActionCtx,
  args: {
    conversationId: Id<"conversations">;
    taskCreatedAt: number;
    panelName: string;
  },
): Promise<boolean> => {
  const panelFileSuffix = `/${args.panelName}.tsx`.toLowerCase();
  const events = await ctx.runQuery(internal.events.listEventsSince, {
    conversationId: args.conversationId,
    afterTimestamp: Math.max(0, args.taskCreatedAt - 5_000),
    limit: PANEL_WRITE_SCAN_LIMIT,
  });

  const candidateRequestIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool_request") continue;
    if (!event.requestId) continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    if (asString(payload.toolName)?.toLowerCase() !== "write") continue;

    const toolArgs = asRecord(payload.args);
    const filePath = asString(toolArgs?.file_path);
    if (!filePath) continue;
    if (!toLowerPath(filePath).endsWith(panelFileSuffix)) continue;

    candidateRequestIds.add(event.requestId);
  }

  if (candidateRequestIds.size === 0) {
    return false;
  }

  for (const event of events) {
    if (event.type !== "tool_result") continue;
    if (!event.requestId || !candidateRequestIds.has(event.requestId)) continue;

    const payload = asRecord(event.payload);
    if (!payload) continue;
    const toolError = asString(payload.error);
    if (toolError) continue;

    const resultText = asString(payload.result);
    if (resultText && resultText.trim().toUpperCase().startsWith("ERROR:")) {
      continue;
    }

    return true;
  }

  return false;
};

const toPanelName = (pageId: string) => {
  const base = slugify(pageId) || `page_${Date.now()}`;
  const panel = `pd_${base}`.slice(0, 64);
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(panel) ? panel : "pd_dashboard_page";
};

const cleanSources = (sources: string[] | undefined): string[] => {
  if (!Array.isArray(sources)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const source of sources) {
    const normalized = normalizeText(source, 120);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(normalized);
  }
  return cleaned.slice(0, 8);
};

const scoreTemplate = (template: PageTemplate, profileText: string): number => {
  let score = 0;

  for (const tag of template.tags) {
    const keywords = TAG_KEYWORDS[tag] ?? [];
    for (const keyword of keywords) {
      if (profileText.includes(keyword)) {
        score += tag === "general" ? 1 : 3;
      }
    }
  }

  if (profileText.includes(template.id.replace(/_/g, " "))) {
    score += 4;
  }

  return score;
};

const buildHeuristicAssignments = (coreMemory: string): PlannedPage[] => {
  const profileText = coreMemory.toLowerCase();
  const scored = PAGE_TEMPLATES
    .map((template) => ({ template, score: scoreTemplate(template, profileText) }))
    .sort((a, b) => b.score - a.score || a.template.title.localeCompare(b.template.title));

  const targetCount = Math.max(2, Math.min(4, coreMemory.length > 1400 ? 4 : 3));
  const picked: PageTemplate[] = [];

  for (const entry of scored) {
    if (picked.length >= targetCount) break;
    if (entry.score <= 0) continue;
    picked.push(entry.template);
  }

  if (picked.length < 2) {
    for (const fallbackId of DEFAULT_TEMPLATE_IDS) {
      if (picked.length >= targetCount) break;
      const template = PAGE_TEMPLATES.find((item) => item.id === fallbackId);
      if (!template) continue;
      if (picked.some((existing) => existing.id === template.id)) continue;
      picked.push(template);
    }
  }

  return picked.slice(0, targetCount).map((template, index) => ({
    pageId: template.id,
    panelName: toPanelName(template.id),
    title: template.title,
    topic: template.topic,
    focus: template.focus,
    dataSources: template.dataSources,
    order: index,
  }));
};

const buildAssignmentsFromInput = (
  input: Array<{
    pageId?: string;
    title: string;
    topic: string;
    focus: string;
    dataSources?: string[];
  }>,
): PlannedPage[] => {
  const unique = new Map<string, PlannedPage>();

  for (const raw of input.slice(0, 4)) {
    const title = normalizeText(raw.title, 80);
    const topic = normalizeText(raw.topic, 180);
    const focus = normalizeText(raw.focus, 400);
    const baseId = normalizeText(raw.pageId ?? "", 64) || slugify(title);
    const pageId = slugify(baseId || title || topic || "page") || `page_${unique.size + 1}`;
    if (!title || !topic || !focus || unique.has(pageId)) continue;

    unique.set(pageId, {
      pageId,
      panelName: toPanelName(pageId),
      title,
      topic,
      focus,
      dataSources: cleanSources(raw.dataSources),
      order: unique.size,
    });
  }

  return Array.from(unique.values()).slice(0, 4);
};

const toAssignment = (page: PlannedPage): PersonalizedDashboardPageAssignment => ({
  pageId: page.pageId,
  panelName: page.panelName,
  title: page.title,
  topic: page.topic,
  focus: page.focus,
  dataSources: page.dataSources,
});

const resolveTaskAnchorEventId = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
  pageId: string,
): Promise<Id<"events">> => {
  const latestEventId = await ctx.runQuery(internal.personalized_dashboard.getLatestEventIdForConversationInternal, {
    conversationId,
  });

  if (latestEventId) {
    return latestEventId;
  }

  const created = await ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId,
    type: "dashboard_generation_anchor",
    payload: {
      source: "personalized_dashboard",
      pageId,
    },
  });

  if (!created) {
    throw new Error("Failed to create task anchor event.");
  }

  return created._id;
};

export const listPagesForOwnerInternal = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: v.array(dashboardPageRecordValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_order", (q) => q.eq("ownerId", args.ownerId))
      .collect();
  },
});

export const getPageByOwnerAndPageIdInternal = internalQuery({
  args: {
    ownerId: v.string(),
    pageId: v.string(),
  },
  returns: v.union(dashboardPageRecordValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", args.ownerId).eq("pageId", args.pageId),
      )
      .unique();
  },
});

export const getLatestEventIdForConversationInternal = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(v.id("events"), v.null()),
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();

    return latest?._id ?? null;
  },
});

export const upsertPlannedPagesInternal = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    pages: v.array(plannedPageValidator),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_order", (q) => q.eq("ownerId", args.ownerId))
      .collect();

    const keepPageIds = new Set(args.pages.map((page) => page.pageId));
    const existingByPageId = new Map(existing.map((page) => [page.pageId, page]));

    for (const page of existing) {
      if (!keepPageIds.has(page.pageId)) {
        await ctx.db.delete(page._id);
      }
    }

    for (const page of args.pages) {
      const prev = existingByPageId.get(page.pageId);
      if (prev) {
        await ctx.db.patch(prev._id, {
          conversationId: args.conversationId,
          panelName: page.panelName,
          title: page.title,
          topic: page.topic,
          focus: page.focus,
          dataSources: page.dataSources,
          status: "queued" satisfies DashboardPageStatus,
          order: page.order,
          taskId: undefined,
          retryCount: 0,
          statusText: "Queued",
          lastError: undefined,
          completedAt: undefined,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("dashboard_pages", {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          pageId: page.pageId,
          panelName: page.panelName,
          title: page.title,
          topic: page.topic,
          focus: page.focus,
          dataSources: page.dataSources,
          status: "queued" satisfies DashboardPageStatus,
          order: page.order,
          taskId: undefined,
          retryCount: 0,
          statusText: "Queued",
          lastError: undefined,
          createdAt: now,
          updatedAt: now,
          completedAt: undefined,
        });
      }
    }

    return args.pages.map((page) => page.pageId);
  },
});

export const markPageTaskStartedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    pageId: v.string(),
    taskId: v.id("tasks"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", args.ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) return null;

    await ctx.db.patch(record._id, {
      status: "running" satisfies DashboardPageStatus,
      taskId: args.taskId,
      statusText: "Generating page...",
      lastError: undefined,
      updatedAt: Date.now(),
      completedAt: undefined,
    });

    return null;
  },
});

export const updatePageProgressInternal = internalMutation({
  args: {
    ownerId: v.string(),
    pageId: v.string(),
    statusText: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", args.ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) return null;

    await ctx.db.patch(record._id, {
      status: "running" satisfies DashboardPageStatus,
      statusText: normalizeText(args.statusText, 180),
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const markPageReadyInternal = internalMutation({
  args: {
    ownerId: v.string(),
    pageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", args.ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) return null;

    const now = Date.now();
    await ctx.db.patch(record._id, {
      status: "ready" satisfies DashboardPageStatus,
      statusText: "Ready",
      lastError: undefined,
      updatedAt: now,
      completedAt: now,
    });

    return null;
  },
});

export const markPageFailedInternal = internalMutation({
  args: {
    ownerId: v.string(),
    pageId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", args.ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) return null;

    const now = Date.now();
    await ctx.db.patch(record._id, {
      status: "failed" satisfies DashboardPageStatus,
      statusText: "Failed",
      lastError: normalizeText(args.error, 800),
      updatedAt: now,
      completedAt: now,
      taskId: undefined,
    });

    return null;
  },
});

export const queuePageRetryInternal = internalMutation({
  args: {
    ownerId: v.string(),
    pageId: v.string(),
  },
  returns: v.object({
    queued: v.boolean(),
    retryCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", args.ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) {
      return { queued: false, retryCount: 0 };
    }

    const retryCount = (record.retryCount ?? 0) + 1;
    await ctx.db.patch(record._id, {
      status: "queued" satisfies DashboardPageStatus,
      statusText: `Retrying (${retryCount}/${PAGE_MAX_RETRIES})...`,
      retryCount,
      lastError: undefined,
      taskId: undefined,
      updatedAt: Date.now(),
      completedAt: undefined,
    });

    return { queued: true, retryCount };
  },
});

export const launchPageGenerationTaskInternal = internalAction({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    pageId: v.string(),
    targetDeviceId: v.optional(v.string()),
  },
  returns: v.object({
    launched: v.boolean(),
    taskId: v.union(v.id("tasks"), v.null()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{
    launched: boolean;
    taskId: Id<"tasks"> | null;
    error?: string;
  }> => {
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: args.conversationId,
    });

    if (!conversation || conversation.ownerId !== args.ownerId) {
      return {
        launched: false,
        taskId: null,
        error: "Conversation not found.",
      };
    }

    const page = await ctx.runQuery(internal.personalized_dashboard.getPageByOwnerAndPageIdInternal, {
      ownerId: args.ownerId,
      pageId: args.pageId,
    });

    if (!page) {
      return {
        launched: false,
        taskId: null,
        error: "Page assignment not found.",
      };
    }

    // Attempt to claim the page via lease before generating
    const claimResult = await ctx.runMutation(internal.personalized_dashboard.claimPageGeneration, {
      pageId: page._id,
      claimantId: "server",
    });

    if (!claimResult.claimed) {
      return {
        launched: false,
        taskId: null,
        error: `Page already claimed by ${claimResult.claimedBy ?? "unknown"}`,
      };
    }

    const executionTarget = await ctx.runQuery(internal.agent.device_resolver.resolveExecutionTarget, {
      ownerId: args.ownerId,
    });

    const hintedTargetDeviceId = normalizeText(args.targetDeviceId ?? "", 256);
    const latestConversationDeviceId = await ctx.runQuery(internal.events.getLatestDeviceIdForConversation, {
      conversationId: args.conversationId,
    });

    let resolvedTargetDeviceId: string | null = executionTarget.targetDeviceId;
    if (!resolvedTargetDeviceId && hintedTargetDeviceId) {
      resolvedTargetDeviceId = hintedTargetDeviceId;
    }
    if (!resolvedTargetDeviceId && latestConversationDeviceId) {
      resolvedTargetDeviceId = latestConversationDeviceId;
    }

    if (!resolvedTargetDeviceId) {
      // Release the claim since we can't execute
      await ctx.runMutation(internal.personalized_dashboard.releasePageClaim, {
        pageId: page._id,
        claimantId: "server",
      });
      const error = "Local desktop runtime appears offline. Keep Stella open and connected, then retry.";
      await ctx.runMutation(internal.personalized_dashboard.markPageFailedInternal, {
        ownerId: args.ownerId,
        pageId: args.pageId,
        error,
      });
      return {
        launched: false,
        taskId: null,
        error,
      };
    }

    // If desktop is online, emit a dashboard_generation_request event so the local
    // runtime can claim and generate locally instead. Release the server claim.
    if (resolvedTargetDeviceId && !executionTarget.spriteName) {
      await ctx.runMutation(internal.personalized_dashboard.releasePageClaim, {
        pageId: page._id,
        claimantId: "server",
      });

      // Build the prompt so the local runner has everything it needs
      const coreMemoryRaw = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
        ownerId: args.ownerId,
        key: CORE_MEMORY_KEY,
      });
      const coreMemory = normalizeText(coreMemoryRaw ?? "", 12_000);
      const assignment = toAssignment({
        pageId: page.pageId,
        panelName: page.panelName,
        title: page.title,
        topic: page.topic,
        focus: page.focus,
        dataSources: page.dataSources,
        order: page.order,
      });
      const userPrompt = buildPersonalizedDashboardPageUserMessage({
        coreMemory,
        assignment,
      });

      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: args.conversationId,
        type: "dashboard_generation_request",
        targetDeviceId: resolvedTargetDeviceId,
        payload: {
          pageId: args.pageId,
          ownerId: args.ownerId,
          panelName: page.panelName,
          title: page.title,
          topic: page.topic,
          focus: page.focus,
          dataSources: page.dataSources,
          systemPrompt: PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
          userPrompt,
        },
      });

      // Schedule a fallback monitor — if the local runner doesn't claim within 30s, retry server-side
      await ctx.scheduler.runAfter(30_000, internal.personalized_dashboard.monitorPageGenerationTaskInternal, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        pageId: args.pageId,
        taskId: "local-pending",
      });

      return { launched: true, taskId: null };
    }

    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
    await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});

    const promptBuild = await buildSystemPrompt(ctx, "general", {
      ownerId: args.ownerId,
    });

    const taskAnchorEventId = await resolveTaskAnchorEventId(ctx, args.conversationId, args.pageId);

    const coreMemoryRaw = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
      ownerId: args.ownerId,
      key: CORE_MEMORY_KEY,
    });
    const coreMemory = normalizeText(coreMemoryRaw ?? "", 12_000);

    const assignment = toAssignment({
      pageId: page.pageId,
      panelName: page.panelName,
      title: page.title,
      topic: page.topic,
      focus: page.focus,
      dataSources: page.dataSources,
      order: page.order,
    });

    const prompt = buildPersonalizedDashboardPageUserMessage({
      coreMemory,
      assignment,
    });
    const description = `Generate personalized page: ${page.title}`;

    const created = await ctx.runMutation(internal.agent.tasks.createTaskRecord, {
      conversationId: args.conversationId,
      userMessageId: taskAnchorEventId,
      targetDeviceId: resolvedTargetDeviceId,
      description,
      prompt,
      agentType: "general",
      parentTaskId: undefined,
      maxTaskDepth: promptBuild.maxTaskDepth,
      commandId: undefined,
    });

    await ctx.runMutation(internal.personalized_dashboard.markPageTaskStartedInternal, {
      ownerId: args.ownerId,
      pageId: args.pageId,
      taskId: created.taskId,
    });

    await ctx.runMutation(internal.events.appendInternalEvent, {
      conversationId: args.conversationId,
      type: "task_started",
      deviceId: resolvedTargetDeviceId,
      targetDeviceId: resolvedTargetDeviceId,
      payload: {
        taskId: created.taskId,
        description,
        agentType: "general",
        source: "personalized_dashboard",
        taskDepth: created.taskDepth,
        maxTaskDepth: created.maxTaskDepth,
      },
    });

    await ctx.scheduler.runAfter(TASK_CHECKIN_INTERVAL_MS, internal.agent.tasks.taskCheckin, {
      conversationId: args.conversationId,
      targetDeviceId: resolvedTargetDeviceId,
      taskId: created.taskId,
    });

    await ctx.scheduler.runAfter(0, internal.agent.tasks.executeSubagent, {
      conversationId: args.conversationId,
      userMessageId: taskAnchorEventId,
      targetDeviceId: resolvedTargetDeviceId,
      spriteName: undefined,
      description,
      prompt,
      subagentType: "general",
      taskId: created.taskId,
      ownerId: args.ownerId,
      parentTaskId: undefined,
      threadId: undefined,
      commandId: undefined,
      systemPromptOverride: PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
      suppressDelivery: true,
    });

    await ctx.scheduler.runAfter(PAGE_MONITOR_INTERVAL_MS, internal.personalized_dashboard.monitorPageGenerationTaskInternal, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      pageId: args.pageId,
      taskId: String(created.taskId),
    });

    return {
      launched: true,
      taskId: created.taskId,
    };
  },
});

export const monitorPageGenerationTaskInternal = internalAction({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    pageId: v.string(),
    taskId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.runQuery(internal.personalized_dashboard.getPageByOwnerAndPageIdInternal, {
      ownerId: args.ownerId,
      pageId: args.pageId,
    });

    if (!page) return null;

    if (args.taskId === "local-pending") {
      if (page.status === "ready" || page.status === "failed") {
        return null;
      }

      const now = Date.now();
      const leaseIsActive = Boolean(
        page.claimedBy &&
        page.leaseExpiresAt &&
        page.leaseExpiresAt > now,
      );

      if (leaseIsActive) {
        await ctx.scheduler.runAfter(
          PAGE_MONITOR_INTERVAL_MS,
          internal.personalized_dashboard.monitorPageGenerationTaskInternal,
          args,
        );
        return null;
      }

      await ctx.runAction(internal.personalized_dashboard.launchPageGenerationTaskInternal, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        pageId: args.pageId,
      });
      return null;
    }

    if (page.taskId && String(page.taskId) !== args.taskId) {
      return null;
    }

    const task = await ctx.runQuery(internal.agent.tasks.getOutputByExternalIdInternal, {
      taskId: args.taskId,
    });

    if (!task) {
      await ctx.runMutation(internal.personalized_dashboard.markPageFailedInternal, {
        ownerId: args.ownerId,
        pageId: args.pageId,
        error: "Task record was not found.",
      });
      return null;
    }

    if (task.status === "running") {
      const latestStatus = task.statusUpdates?.[task.statusUpdates.length - 1]?.text ?? "Generating page...";
      await ctx.runMutation(internal.personalized_dashboard.updatePageProgressInternal, {
        ownerId: args.ownerId,
        pageId: args.pageId,
        statusText: latestStatus,
      });

      await ctx.scheduler.runAfter(PAGE_MONITOR_INTERVAL_MS, internal.personalized_dashboard.monitorPageGenerationTaskInternal, args);
      return null;
    }

    if (task.status === "completed") {
      const hasWrittenPanelFile = await didTaskWritePanelFile(ctx, {
        conversationId: args.conversationId,
        taskCreatedAt: task.createdAt,
        panelName: page.panelName,
      });

      if (!hasWrittenPanelFile) {
        const verificationError = `Generation finished but did not write ${page.panelName}.tsx to workspace/panels.`;
        if ((page.retryCount ?? 0) < PAGE_MAX_RETRIES) {
          const retry = await ctx.runMutation(internal.personalized_dashboard.queuePageRetryInternal, {
            ownerId: args.ownerId,
            pageId: args.pageId,
          });

          if (retry.queued) {
            await ctx.scheduler.runAfter(PAGE_RETRY_DELAY_MS, internal.personalized_dashboard.launchPageGenerationTaskInternal, {
              ownerId: args.ownerId,
              conversationId: args.conversationId,
              pageId: args.pageId,
            });
            return null;
          }
        }

        await ctx.runMutation(internal.personalized_dashboard.markPageFailedInternal, {
          ownerId: args.ownerId,
          pageId: args.pageId,
          error: verificationError,
        });
        return null;
      }

      await ctx.runMutation(internal.personalized_dashboard.markPageReadyInternal, {
        ownerId: args.ownerId,
        pageId: args.pageId,
      });
      return null;
    }

    const errorText = normalizeText(task.error ?? task.result ?? "Generation failed.", 900);
    if ((page.retryCount ?? 0) < PAGE_MAX_RETRIES) {
      const retry = await ctx.runMutation(internal.personalized_dashboard.queuePageRetryInternal, {
        ownerId: args.ownerId,
        pageId: args.pageId,
      });

      if (retry.queued) {
        await ctx.scheduler.runAfter(PAGE_RETRY_DELAY_MS, internal.personalized_dashboard.launchPageGenerationTaskInternal, {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          pageId: args.pageId,
        });
        return null;
      }
    }

    await ctx.runMutation(internal.personalized_dashboard.markPageFailedInternal, {
      ownerId: args.ownerId,
      pageId: args.pageId,
      error: errorText,
    });

    return null;
  },
});

export const listPages = query({
  args: {},
  returns: v.object({
    pages: v.array(sidebarPageValidator),
    hasRunning: v.boolean(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { pages: [], hasRunning: false };
    const ownerId = identity.subject;
    const rows = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_order", (q) => q.eq("ownerId", ownerId))
      .collect();

    const pages = rows
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map((page) => ({
        pageId: page.pageId,
        panelName: page.panelName,
        title: page.title,
        status: page.status,
        order: page.order,
        statusText: page.statusText,
        lastError: page.lastError,
      }));

    return {
      pages,
      hasRunning: pages.some((page) => page.status === "queued" || page.status === "running"),
    };
  },
});

export const startGeneration = action({
  args: {
    conversationId: v.id("conversations"),
    coreMemory: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    pageAssignments: v.optional(v.array(pageAssignmentInputValidator)),
    force: v.optional(v.boolean()),
  },
  returns: startGenerationResultValidator,
  handler: async (ctx, args): Promise<{
    started: boolean;
    pageIds: string[];
    skippedReason?: string;
  }> => {
    const ownerId = await requireUserId(ctx);
    await requireConversationOwnerAction(ctx, args.conversationId);

    const manualAssignments = args.pageAssignments
      ? buildAssignmentsFromInput(args.pageAssignments)
      : [];

    const existing = (await ctx.runQuery(internal.personalized_dashboard.listPagesForOwnerInternal, {
      ownerId,
    })) as Array<{ pageId: string; status: DashboardPageStatus }>;

    let normalizedCoreMemory = normalizeText(args.coreMemory ?? "", 12_000);
    if (!normalizedCoreMemory) {
      const storedCoreMemory = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
        ownerId,
        key: CORE_MEMORY_KEY,
      });
      normalizedCoreMemory = normalizeText(storedCoreMemory ?? "", 12_000);
    }

    if (!normalizedCoreMemory && manualAssignments.length < 2) {
      return {
        started: false,
        pageIds: existing.map((page) => page.pageId),
        skippedReason: "missing_core_memory",
      };
    }

    const planned = manualAssignments.length >= 2
      ? manualAssignments.slice(0, 4)
      : buildHeuristicAssignments(normalizedCoreMemory);

    const hasActive = existing.some((page) => page.status === "queued" || page.status === "running");
    if (hasActive && !args.force) {
      return {
        started: false,
        pageIds: existing.map((page) => page.pageId),
        skippedReason: "generation_in_progress",
      };
    }

    const hasReady = existing.some((page) => page.status === "ready");
    if (hasReady && !args.force && !args.pageAssignments) {
      return {
        started: false,
        pageIds: existing.map((page) => page.pageId),
        skippedReason: "already_generated",
      };
    }

    if (normalizedCoreMemory) {
      await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
        ownerId,
        key: CORE_MEMORY_KEY,
        value: normalizedCoreMemory,
      });
    }

    await ctx.runMutation(internal.personalized_dashboard.upsertPlannedPagesInternal, {
      ownerId,
      conversationId: args.conversationId,
      pages: planned,
    });

    const launched = await Promise.all(
      planned.map((page) =>
        ctx.runAction(internal.personalized_dashboard.launchPageGenerationTaskInternal, {
          ownerId,
          conversationId: args.conversationId,
          pageId: page.pageId,
          targetDeviceId: args.targetDeviceId,
        }),
      ),
    );

    const started = launched.some(
      (result: { launched: boolean; taskId: Id<"tasks"> | null; error?: string }) =>
        result.launched,
    );

    return {
      started,
      pageIds: planned.map((page) => page.pageId),
      skippedReason: started ? undefined : launched[0]?.error ?? "no_launchable_pages",
    };
  },
});

export const retryPage = action({
  args: {
    conversationId: v.id("conversations"),
    pageId: v.string(),
    targetDeviceId: v.optional(v.string()),
  },
  returns: v.object({
    started: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args): Promise<{ started: boolean; message: string }> => {
    const ownerId = await requireUserId(ctx);
    await requireConversationOwnerAction(ctx, args.conversationId);

    const page = await ctx.runQuery(internal.personalized_dashboard.getPageByOwnerAndPageIdInternal, {
      ownerId,
      pageId: args.pageId,
    });

    if (!page) {
      return { started: false, message: "Page was not found." };
    }

    if (page.status === "running" || page.status === "queued") {
      return { started: false, message: "Page is already generating." };
    }

    await ctx.runMutation(internal.personalized_dashboard.queuePageRetryInternal, {
      ownerId,
      pageId: args.pageId,
    });

    const launch = await ctx.runAction(internal.personalized_dashboard.launchPageGenerationTaskInternal, {
      ownerId,
      conversationId: args.conversationId,
      pageId: args.pageId,
      targetDeviceId: args.targetDeviceId,
    });

    if (!launch.launched) {
      return {
        started: false,
        message: launch.error ?? "Failed to start retry.",
      };
    }

    return {
      started: true,
      message: "Retry started.",
    };
  },
});

// ─── Dashboard Generation Claim/Lease ──────────────────────────────────────
// Prevents duplicate generation when both desktop (local) and server (cloud)
// runners could attempt to generate the same panel.
//
// Flow:
// 1. Runner (local or server) calls claimPageGeneration with its device/runner ID
// 2. CAS: succeeds only if claimedBy is null OR lease has expired
// 3. During generation, runner calls renewPageLease every 60s
// 4. On completion/failure, runner calls releasePageClaim
// 5. If runner crashes, lease expires and another runner can claim

const DEFAULT_LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes

export const claimPageGeneration = internalMutation({
  args: {
    pageId: v.id("dashboard_pages"),
    claimantId: v.string(), // deviceId or "server"
  },
  returns: v.object({
    claimed: v.boolean(),
    claimedBy: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      return { claimed: false, claimedBy: undefined };
    }

    const now = Date.now();

    // CAS: only claim if unclaimed or lease expired
    if (page.claimedBy && page.leaseExpiresAt && page.leaseExpiresAt > now) {
      return { claimed: false, claimedBy: page.claimedBy };
    }

    await ctx.db.patch(args.pageId, {
      claimedBy: args.claimantId,
      claimedAt: now,
      leaseExpiresAt: now + DEFAULT_LEASE_DURATION_MS,
      updatedAt: now,
    });

    return { claimed: true, claimedBy: args.claimantId };
  },
});

export const renewPageLease = internalMutation({
  args: {
    pageId: v.id("dashboard_pages"),
    claimantId: v.string(),
  },
  returns: v.object({
    renewed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      return { renewed: false };
    }

    // Only the current claimant can renew
    if (page.claimedBy !== args.claimantId) {
      return { renewed: false };
    }

    const now = Date.now();
    await ctx.db.patch(args.pageId, {
      leaseExpiresAt: now + DEFAULT_LEASE_DURATION_MS,
      updatedAt: now,
    });

    return { renewed: true };
  },
});

export const releasePageClaim = internalMutation({
  args: {
    pageId: v.id("dashboard_pages"),
    claimantId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) return null;

    // Only the current claimant can release
    if (page.claimedBy !== args.claimantId) return null;

    await ctx.db.patch(args.pageId, {
      claimedBy: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// ─── Public Mutation Wrappers (for device runner) ──────────────────────────
// These wrap the internal mutations with auth checks so the local runner
// can call them via the Convex client.

export const claimPageGenerationDevice = mutation({
  args: {
    pageId: v.string(),
    claimantId: v.string(),
  },
  returns: v.object({
    claimed: v.boolean(),
    claimedBy: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) return { claimed: false, claimedBy: undefined };

    const now = Date.now();
    if (record.claimedBy && record.leaseExpiresAt && record.leaseExpiresAt > now) {
      return { claimed: false, claimedBy: record.claimedBy };
    }

    await ctx.db.patch(record._id, {
      claimedBy: args.claimantId,
      claimedAt: now,
      leaseExpiresAt: now + DEFAULT_LEASE_DURATION_MS,
      updatedAt: now,
    });

    return { claimed: true, claimedBy: args.claimantId };
  },
});

export const renewPageLeaseDevice = mutation({
  args: {
    pageId: v.string(),
    claimantId: v.string(),
  },
  returns: v.object({ renewed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record || record.claimedBy !== args.claimantId) return { renewed: false };

    const now = Date.now();
    await ctx.db.patch(record._id, {
      leaseExpiresAt: now + DEFAULT_LEASE_DURATION_MS,
      updatedAt: now,
    });
    return { renewed: true };
  },
});

export const releasePageClaimDevice = mutation({
  args: {
    pageId: v.string(),
    claimantId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record || record.claimedBy !== args.claimantId) return null;

    await ctx.db.patch(record._id, {
      claimedBy: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const markPageReadyDevice = mutation({
  args: {
    pageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) return null;

    const now = Date.now();
    await ctx.db.patch(record._id, {
      status: "ready" satisfies DashboardPageStatus,
      statusText: "Ready",
      lastError: undefined,
      updatedAt: now,
      completedAt: now,
      claimedBy: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
    });
    return null;
  },
});

export const markPageFailedDevice = mutation({
  args: {
    pageId: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("dashboard_pages")
      .withIndex("by_ownerId_and_pageId", (q) =>
        q.eq("ownerId", ownerId).eq("pageId", args.pageId),
      )
      .unique();
    if (!record) return null;

    const now = Date.now();
    await ctx.db.patch(record._id, {
      status: "failed" satisfies DashboardPageStatus,
      statusText: "Failed",
      lastError: normalizeText(args.error, 800),
      updatedAt: now,
      completedAt: now,
      taskId: undefined,
      claimedBy: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined,
    });
    return null;
  },
});
