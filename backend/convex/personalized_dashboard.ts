import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireConversationOwnerAction, requireUserId } from "./auth";
import {
  PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
  buildPersonalizedDashboardPageUserMessage,
  type PersonalizedDashboardPageAssignment,
} from "./prompts/personalized_dashboard";

const CORE_MEMORY_KEY = "core_memory";

// --- Types ---

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

// --- Templates ---

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

// --- Utilities ---

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

// --- Planning ---

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

// --- Validators ---

const pageAssignmentInputValidator = v.object({
  pageId: v.optional(v.string()),
  title: v.string(),
  topic: v.string(),
  focus: v.string(),
  dataSources: v.optional(v.array(v.string())),
});

const startGenerationResultValidator = v.object({
  started: v.boolean(),
  pageIds: v.array(v.string()),
  skippedReason: v.optional(v.string()),
});

// --- Public API ---

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
        pageIds: [],
        skippedReason: "missing_core_memory",
      };
    }

    const planned = manualAssignments.length >= 2
      ? manualAssignments.slice(0, 4)
      : buildHeuristicAssignments(normalizedCoreMemory);

    if (normalizedCoreMemory) {
      await ctx.runMutation(internal.data.preferences.setPreferenceForOwner, {
        ownerId,
        key: CORE_MEMORY_KEY,
        value: normalizedCoreMemory,
      });
    }

    // Resolve which device to target
    const executionTarget = await ctx.runQuery(internal.agent.device_resolver.resolveExecutionTarget, {
      ownerId,
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
      return {
        started: false,
        pageIds: [],
        skippedReason: "device_offline",
      };
    }

    // Dispatch each page as a dashboard_generation_request event to the local runner
    for (const page of planned) {
      const assignment = toAssignment(page);
      const userPrompt = buildPersonalizedDashboardPageUserMessage({
        coreMemory: normalizedCoreMemory,
        assignment,
      });

      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: args.conversationId,
        type: "dashboard_generation_request",
        targetDeviceId: resolvedTargetDeviceId,
        payload: {
          pageId: page.pageId,
          ownerId,
          panelName: page.panelName,
          title: page.title,
          topic: page.topic,
          focus: page.focus,
          dataSources: page.dataSources,
          systemPrompt: PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT,
          userPrompt,
        },
      });
    }

    return {
      started: true,
      pageIds: planned.map((page) => page.pageId),
    };
  },
});
