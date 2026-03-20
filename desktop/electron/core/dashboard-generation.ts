import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TaskToolRequest,
  TaskToolSnapshot,
} from "./runtime/tools/types.js";
import { createRuntimeLogger } from "./runtime/debug.js";
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
  /** Absolute path to the project root (desktop/) so we can write registry.ts. */
  projectRoot: string;
};

type CreateBackgroundTask = (
  request: Omit<TaskToolRequest, "storageMode">,
) => Promise<{ taskId: string }>;

type GetLocalTaskSnapshot = (
  taskId: string,
) => Promise<TaskToolSnapshot | null>;

const DASHBOARD_GENERATION_TOOLS = ["Read", "Write"] as const;
const logger = createRuntimeLogger("dashboard-generation");

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

const REGISTRY_MARKER =
  "// --- generated entries below (do not remove this line) ---";

/**
 * Append registry entries for the given pages (typically those whose generation tasks completed).
 * Lazy imports must resolve — only include pages whose component files exist.
 */
async function writeRegistryEntries(
  projectRoot: string,
  pages: PlannedPage[],
): Promise<void> {
  const registryPath = join(projectRoot, "src", "app", "registry.ts");
  const content = await readFile(registryPath, "utf-8");

  const newEntries = pages
    .map(
      (p) =>
        `  { id: "${p.panelName}", title: ${JSON.stringify(p.title)}, component: lazy(() => import("./${p.panelName}/${p.componentName}")) },`,
    )
    .join("\n");

  const updated = content.replace(
    REGISTRY_MARKER,
    `${REGISTRY_MARKER}\n${newEntries}`,
  );

  await writeFile(registryPath, updated, "utf-8");
}

const TASK_POLL_MS = 250;

const waitForTaskTerminal = async (
  getTask: GetLocalTaskSnapshot,
  taskId: string,
): Promise<TaskToolSnapshot> => {
  while (true) {
    const snapshot = await getTask(taskId);
    if (!snapshot) {
      logger.error("task.disappeared", { taskId });
      throw new Error(`Dashboard generation task disappeared: ${taskId}`);
    }
    if (
      snapshot.status === "completed" ||
      snapshot.status === "error" ||
      snapshot.status === "canceled"
    ) {
      logger.info("task.terminal", {
        taskId,
        description: snapshot.description,
        status: snapshot.status,
        error: snapshot.error,
      });
      return snapshot;
    }
    await new Promise((r) => setTimeout(r, TASK_POLL_MS));
  }
};

export const startDashboardGeneration = async (
  createTask: CreateBackgroundTask,
  getTask: GetLocalTaskSnapshot,
  request: DashboardGenerationRequest,
): Promise<void> => {
  assert(
    request.plannedPages.length === 3,
    `Expected 3 planned dashboard pages, got ${request.plannedPages.length}`,
  );

  const seenPageIds = new Set<string>();
  const pages = request.plannedPages.map((page) =>
    toPlannedPage(page, seenPageIds),
  );
  logger.info("batch.start", {
    conversationId: request.conversationId,
    pages: pages.map((page) => ({
      pageId: page.pageId,
      panelName: page.panelName,
      title: page.title,
    })),
  });

  const taskIds: string[] = [];
  for (const page of pages) {
    const { taskId } = await createTask({
      conversationId: request.conversationId,
      description: `Generate app: ${page.title}`,
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
    taskIds.push(taskId);
    logger.info("task.created", {
      taskId,
      pageId: page.pageId,
      panelName: page.panelName,
      title: page.title,
    });
  }

  const snapshots = await Promise.all(
    taskIds.map((taskId) => waitForTaskTerminal(getTask, taskId)),
  );

  const successfulPages = pages.filter(
    (_, i) => snapshots[i]?.status === "completed",
  );

  if (successfulPages.length === 0) {
    const detail = snapshots
      .map(
        (s) =>
          `${s.description}: ${s.error?.trim() || s.status}`,
      )
      .join("; ");
    logger.error("batch.failed", {
      conversationId: request.conversationId,
      detail,
    });
    throw new Error(`Dashboard generation failed (${detail})`);
  }

  if (successfulPages.length < pages.length) {
    const failedLines = snapshots
      .map((s, i) =>
        s.status === "completed"
          ? null
          : `${pages[i]?.title ?? pages[i]?.pageId}: ${s.error?.trim() || s.status}`,
      )
      .filter((line): line is string => line != null);
    console.warn(
      "[dashboard-generation] Partial success: registering %d/%d pages. Failed: %s",
      successfulPages.length,
      pages.length,
      failedLines.join("; "),
    );
    logger.warn("batch.partial", {
      conversationId: request.conversationId,
      successfulPanels: successfulPages.map((page) => page.panelName),
      failed: failedLines,
    });
  }

  await writeRegistryEntries(request.projectRoot, successfulPages);
  logger.info("registry.updated", {
    conversationId: request.conversationId,
    panels: successfulPages.map((page) => page.panelName),
  });
};
