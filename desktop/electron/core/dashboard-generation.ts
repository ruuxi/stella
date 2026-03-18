/**
 * Dashboard page generation: template scoring + task spawning.
 * Ported from backend/convex/personalized_dashboard.ts for local execution.
 */

import type { TaskToolRequest } from "./runtime/tools/types.js";

// --- Types ---

type PageTemplate = {
  id: string;
  title: string;
  topic: string;
  focus: string;
  tags: string[];
  dataSources: string[];
};

export type PlannedPage = {
  pageId: string;
  panelName: string;
  componentName: string;
  title: string;
  topic: string;
  focus: string;
  dataSources: string[];
  order: number;
};

export type DashboardPromptConfig = {
  systemPrompt: string;
  userPromptTemplate: string;
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
    dataSources: [
      "Music publication RSS feeds",
      "Wikipedia featured content",
      "Reddit music JSON",
    ],
  },
  {
    id: "practice_tracker",
    title: "Practice Tracker",
    topic: "Daily/weekly practice momentum",
    focus:
      "Provide a lightweight, interactive practice tracker with suggestions the user can ask Stella to expand.",
    tags: ["music", "habit", "practice"],
    dataSources: [
      "Wikipedia random music topics",
      "Public metronome/tempo references",
    ],
  },
  {
    id: "gear_watch",
    title: "Gear",
    topic: "Instrument and production gear updates",
    focus:
      "Track new gear announcements, availability chatter, and notable reviews from public feeds.",
    tags: ["music", "producer", "hardware"],
    dataSources: [
      "Retail/public gear RSS feeds",
      "Reddit gear JSON",
      "YouTube channel RSS",
    ],
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
    "developer", "engineer", "software", "coding", "programming",
    "typescript", "javascript", "python", "github", "devops",
    "backend", "frontend",
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

const MAX_PAGES = 3;

// --- Utilities ---

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

const toPanelName = (pageId: string) => {
  const base = slugify(pageId) || `page_${Date.now()}`;
  return base.replace(/_/g, "-");
};

const toPascalCase = (kebab: string) =>
  kebab
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

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

export const buildHeuristicAssignments = (
  userProfile: string,
  max = MAX_PAGES,
): PlannedPage[] => {
  const profileText = userProfile.toLowerCase();
  const scored = PAGE_TEMPLATES
    .map((template) => ({ template, score: scoreTemplate(template, profileText) }))
    .sort((a, b) => b.score - a.score || a.template.title.localeCompare(b.template.title));

  const targetCount = Math.max(2, Math.min(max, userProfile.length > 1400 ? max : Math.min(max, 3)));
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

  return picked.slice(0, targetCount).map((template, index) => {
    const panelName = toPanelName(template.id);
    return {
      pageId: template.id,
      panelName,
      componentName: toPascalCase(panelName),
      title: template.title,
      topic: template.topic,
      focus: template.focus,
      dataSources: template.dataSources,
      order: index,
    };
  });
};

// --- Prompt rendering ---

const buildUserPrompt = (
  page: PlannedPage,
  userProfile: string,
  template: string,
): string => {
  const sources =
    page.dataSources.length > 0
      ? page.dataSources.map((s) => `- ${s}`).join("\n")
      : "- Find relevant public/free sources matching the page topic.";

  return template
    .replaceAll("{{pageId}}", page.pageId)
    .replaceAll("{{title}}", page.title)
    .replaceAll("{{panelName}}", page.panelName)
    .replaceAll("{{componentName}}", page.componentName)
    .replaceAll("{{topic}}", page.topic)
    .replaceAll("{{focus}}", page.focus)
    .replaceAll("{{suggestedSources}}", sources)
    .replaceAll("{{userProfile}}", userProfile);
};

// --- Task creation ---

export type TaskCreator = {
  createTask: (request: TaskToolRequest) => Promise<{ taskId: string }>;
};

export const startDashboardGeneration = async (
  taskCreator: TaskCreator,
  conversationId: string,
  coreMemory: string,
  promptConfig: DashboardPromptConfig,
): Promise<{ taskIds: string[] }> => {
  const assignments = buildHeuristicAssignments(coreMemory, MAX_PAGES);
  const taskIds: string[] = [];

  for (const page of assignments) {
    const userPrompt = buildUserPrompt(
      page,
      coreMemory,
      promptConfig.userPromptTemplate,
    );

    const { taskId } = await taskCreator.createTask({
      conversationId,
      description: `Generate dashboard page: ${page.title}`,
      prompt: userPrompt,
      agentType: "self_mod",
      systemPromptOverride: promptConfig.systemPrompt,
      storageMode: "local",
      maxTaskDepth: 1,
    });

    taskIds.push(taskId);
  }

  return { taskIds };
};
