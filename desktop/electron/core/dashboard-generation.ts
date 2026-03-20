import type { TaskToolRequest } from "./runtime/tools/types.js";
import { AGENT_IDS } from "../../src/shared/contracts/agent-runtime.js";
import { buildPageFocusGuidance } from "../../src/prompts/dashboard-page-focus.js";

export type DashboardPlannedPage = {
  pageId: string;
  title: string;
  topic: string;
  focus: string;
  dataSources: string[];
  personalOrEntertainment: boolean;
};

export type DashboardGenerationRequest = {
  conversationId: string;
  coreMemory: string;
  plannedPages: DashboardPlannedPage[];
  promptConfig: {
    systemPrompt: string;
    userPromptTemplate: string;
  };
};

type CreateBackgroundTask = (
  request: Omit<TaskToolRequest, "storageMode">,
) => Promise<void>;

const DASHBOARD_GENERATION_TOOLS = ["Read", "Write", "Edit"] as const;

type PlannedPage = DashboardPlannedPage & {
  panelName: string;
  componentName: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const toPanelName = (pageId: string) => pageId.replaceAll("_", "-");

const toComponentName = (panelName: string) =>
  panelName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const toPlannedPage = (
  page: DashboardPlannedPage,
  seenPageIds: Set<string>,
): PlannedPage => {
  const pageId = page.pageId.trim();
  const title = page.title.trim();
  const topic = page.topic.trim();
  const focus = page.focus.trim();
  assert(pageId, "Dashboard pageId is required");
  assert(title, "Dashboard title is required");
  assert(topic, "Dashboard topic is required");
  assert(focus, "Dashboard focus is required");
  assert(!seenPageIds.has(pageId), `Duplicate dashboard pageId: ${pageId}`);
  seenPageIds.add(pageId);

  const panelName = toPanelName(pageId);
  return {
    pageId,
    title,
    topic,
    focus,
    dataSources: page.dataSources.map((source) => {
      const value = source.trim();
      assert(value, `Dashboard page ${pageId} has an empty data source`);
      return value;
    }),
    personalOrEntertainment: page.personalOrEntertainment,
    panelName,
    componentName: toComponentName(panelName),
  };
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
      page.dataSources.length > 0
        ? page.dataSources.map((source) => `- ${source}`).join("\n")
        : "- Find relevant public/free sources matching the page topic.",
    )
    .replaceAll(
      "{{pageFocusGuidance}}",
      buildPageFocusGuidance({
        personalOrEntertainment: page.personalOrEntertainment,
        dataSourcesCount: page.dataSources.length,
      }),
    )
    .replaceAll("{{userProfile}}", coreMemory);

export const startDashboardGeneration = async (
  createTask: CreateBackgroundTask,
  request: DashboardGenerationRequest,
): Promise<void> => {
  assert(
    request.plannedPages.length === 3,
    `Expected 3 planned dashboard pages, got ${request.plannedPages.length}`,
  );

  const seenPageIds = new Set<string>();
  const pages = request.plannedPages.map((page) =>
    toPlannedPage(page, seenPageIds)
  );

  for (const page of pages) {
    await createTask({
      conversationId: request.conversationId,
      description: `Generate dashboard page: ${page.title}`,
      prompt: buildUserPrompt(
        page,
        request.coreMemory,
        request.promptConfig.userPromptTemplate,
      ),
      agentType: AGENT_IDS.DASHBOARD_GENERATION,
      systemPromptOverride: request.promptConfig.systemPrompt,
      toolsAllowlistOverride: [...DASHBOARD_GENERATION_TOOLS],
      omitCoreMemory: true,
      maxTaskDepth: 1,
    });
  }
};
