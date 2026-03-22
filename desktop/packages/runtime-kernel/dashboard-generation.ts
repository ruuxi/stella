import type {
  TaskToolRequest,
  TaskToolSnapshot,
} from "./tools/types.js";
import { createRuntimeLogger } from "./debug.js";
import { AGENT_IDS } from "../../src/shared/contracts/agent-runtime.js";

export type PersonalWebsiteGenerationRequest = {
  conversationId: string;
  coreMemory: string;
  promptConfig: {
    systemPrompt: string;
    userPromptTemplate: string;
  };
};

type CreateBackgroundTask = (
  request: Omit<TaskToolRequest, "storageMode">,
) => Promise<{ taskId: string }>;

type GetLocalTaskSnapshot = (
  taskId: string,
) => Promise<TaskToolSnapshot | null>;

const GENERATION_TOOLS = ["Read", "Write"] as const;
const logger = createRuntimeLogger("dashboard-generation");

const TASK_POLL_MS = 250;

const waitForTaskTerminal = async (
  getTask: GetLocalTaskSnapshot,
  taskId: string,
): Promise<TaskToolSnapshot> => {
  while (true) {
    const snapshot = await getTask(taskId);
    if (!snapshot) {
      logger.error("task.disappeared", { taskId });
      throw new Error(`Generation task disappeared: ${taskId}`);
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

export const startPersonalWebsiteGeneration = async (
  createTask: CreateBackgroundTask,
  getTask: GetLocalTaskSnapshot,
  request: PersonalWebsiteGenerationRequest,
): Promise<void> => {
  const userPrompt = request.promptConfig.userPromptTemplate.replaceAll(
    "{{coreMemory}}",
    request.coreMemory,
  );

  logger.info("generation.start", {
    conversationId: request.conversationId,
  });

  const { taskId } = await createTask({
    conversationId: request.conversationId,
    description: "Generate personal website",
    prompt: userPrompt,
    agentType: AGENT_IDS.DASHBOARD_GENERATION,
    systemPromptOverride: request.promptConfig.systemPrompt,
    toolsAllowlistOverride: [...GENERATION_TOOLS],
    omitCoreMemory: true,
    maxTaskDepth: 1,
  });

  logger.info("task.created", { taskId });

  const snapshot = await waitForTaskTerminal(getTask, taskId);

  if (snapshot.status !== "completed") {
    const detail = snapshot.error?.trim() || snapshot.status;
    logger.error("generation.failed", {
      conversationId: request.conversationId,
      detail,
    });
    throw new Error(`Personal website generation failed (${detail})`);
  }

  logger.info("generation.completed", {
    conversationId: request.conversationId,
  });
};
