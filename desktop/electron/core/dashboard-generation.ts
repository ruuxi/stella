import type { TaskToolRequest } from "./runtime/tools/types.js";

const TAG_KEYWORDS = {
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
} as const;

type PageTag = keyof typeof TAG_KEYWORDS;

type PageTemplate = {
  id: string;
  title: string;
  topic: string;
  focus: string;
  tags: PageTag[];
  dataSources: string[];
};

type PlannedPage = {
  pageId: string;
  panelName: string;
  componentName: string;
  title: string;
  topic: string;
  focus: string;
  dataSources: string[];
};

export type DashboardGenerationRequest = {
  conversationId: string;
  coreMemory: string;
  promptConfig: {
    systemPrompt: string;
    userPromptTemplate: string;
  };
};

type CreateBackgroundTask = (
  request: Omit<TaskToolRequest, "storageMode">,
) => Promise<void>;

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
    dataSources: [
      "Wikipedia featured feed",
      "Open course RSS",
      "Public blog RSS",
    ],
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

const FALLBACK_PAGE_IDS = ["learning_brief", "world_briefing", "tech_feed"];
const PAGE_COUNT = 3;

const toPanelName = (pageId: string) => pageId.replaceAll("_", "-");

const toComponentName = (panelName: string) =>
  panelName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const scoreTemplate = (template: PageTemplate, profileText: string) => {
  let score = 0;

  for (const tag of template.tags) {
    for (const keyword of TAG_KEYWORDS[tag]) {
      if (profileText.includes(keyword)) {
        score += tag === "general" ? 1 : 3;
      }
    }
  }

  if (profileText.includes(template.id.replaceAll("_", " "))) {
    score += 4;
  }

  return score;
};

const buildPagePlan = (coreMemory: string): PlannedPage[] => {
  const profileText = coreMemory.toLowerCase();
  const picked: PageTemplate[] = [];

  const rankedTemplates = PAGE_TEMPLATES.map((template) => ({
    template,
    score: scoreTemplate(template, profileText),
  })).sort(
    (left, right) =>
      right.score - left.score ||
      left.template.title.localeCompare(right.template.title),
  );

  for (const { template, score } of rankedTemplates) {
    if (picked.length === PAGE_COUNT) {
      break;
    }

    if (score > 0) {
      picked.push(template);
    }
  }

  for (const fallbackPageId of FALLBACK_PAGE_IDS) {
    if (picked.length === PAGE_COUNT) {
      break;
    }

    if (picked.some((template) => template.id === fallbackPageId)) {
      continue;
    }

    const fallbackTemplate = PAGE_TEMPLATES.find(
      (template) => template.id === fallbackPageId,
    );

    if (!fallbackTemplate) {
      throw new Error(`Missing dashboard template: ${fallbackPageId}`);
    }

    picked.push(fallbackTemplate);
  }

  return picked.map((template) => {
    const panelName = toPanelName(template.id);

    return {
      pageId: template.id,
      panelName,
      componentName: toComponentName(panelName),
      title: template.title,
      topic: template.topic,
      focus: template.focus,
      dataSources: template.dataSources,
    };
  });
};

const buildUserPrompt = (
  page: PlannedPage,
  coreMemory: string,
  userPromptTemplate: string,
) =>
  userPromptTemplate
    .replaceAll("{{pageId}}", page.pageId)
    .replaceAll("{{title}}", page.title)
    .replaceAll("{{panelName}}", page.panelName)
    .replaceAll("{{componentName}}", page.componentName)
    .replaceAll("{{topic}}", page.topic)
    .replaceAll("{{focus}}", page.focus)
    .replaceAll(
      "{{suggestedSources}}",
      page.dataSources.map((source) => `- ${source}`).join("\n"),
    )
    .replaceAll("{{userProfile}}", coreMemory);

export const startDashboardGeneration = async (
  createTask: CreateBackgroundTask,
  request: DashboardGenerationRequest,
): Promise<void> => {
  for (const page of buildPagePlan(request.coreMemory)) {
    await createTask({
      conversationId: request.conversationId,
      description: `Generate dashboard page: ${page.title}`,
      prompt: buildUserPrompt(
        page,
        request.coreMemory,
        request.promptConfig.userPromptTemplate,
      ),
      agentType: "self_mod",
      systemPromptOverride: request.promptConfig.systemPrompt,
      maxTaskDepth: 1,
    });
  }
};
