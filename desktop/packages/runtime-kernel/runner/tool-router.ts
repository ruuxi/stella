import { completeSimple, readAssistantText } from "../../ai/stream.js";
import { createRuntimeLogger } from "../debug.js";
import type { ToolMetadata } from "../tools/types.js";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import type { RunnerContext } from "./types.js";
import { resolveRunnerLlmRoute } from "./model-selection.js";
import { GENERAL_STARTER_TOOLS } from "../agents/core-agent-prompts.js";

const logger = createRuntimeLogger("runner.tool-router");

const TOOL_ROUTER_SYSTEM_PROMPT = [
  "You are Stella's tool router.",
  "Choose the smallest set of additional tools needed for a task.",
  "You are selecting tools for a general execution agent that already has its starter-pack tools loaded.",
  "Return strict JSON only.",
  'Valid shape: {"tools":["ToolName"]}',
  "Rules:",
  "- Only return tool names from the provided catalog.",
  "- Do not return starter-pack tools or tools already loaded.",
  "- Prefer the minimum sufficient set.",
  "- Do not explain your answer.",
].join("\n");

const TOOL_ROUTER_MAX_TOOLS = 12;

const STARTER_TOOL_SET = new Set<string>(GENERAL_STARTER_TOOLS);
const NON_LOADABLE_TOOL_NAMES = new Set<string>([
  "LoadTools",
  "TaskCreate",
  "TaskUpdate",
  "TaskCancel",
  "TaskOutput",
]);

const stripMarkdownCodeFence = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
};

const parseSelectedTools = (
  raw: string,
  validToolNames: Set<string>,
): string[] => {
  const cleaned = stripMarkdownCodeFence(raw);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const toolValues = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { tools?: unknown }).tools)
        ? (parsed as { tools: unknown[] }).tools
        : [];
    const selected: string[] = [];
    const seen = new Set<string>();
    for (const value of toolValues) {
      if (typeof value !== "string") continue;
      const toolName = value.trim();
      if (!toolName || seen.has(toolName) || !validToolNames.has(toolName)) continue;
      seen.add(toolName);
      selected.push(toolName);
      if (selected.length >= TOOL_ROUTER_MAX_TOOLS) break;
    }
    return selected;
  } catch {
    return [];
  }
};

const buildToolRouterPrompt = (args: {
  description: string;
  prompt: string;
  loadedTools: string[];
  catalog: ToolMetadata[];
}): string => {
  const catalogLines = args.catalog.map(
    (tool) => `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim()}`,
  );
  return [
    `Task description: ${args.description || "(none)"}`,
    "Task prompt:",
    args.prompt.trim() || "(empty)",
    "",
    `Already loaded tools: ${args.loadedTools.join(", ") || "(none)"}`,
    "",
    "Candidate tools:",
    ...catalogLines,
    "",
    'Return JSON only. Example: {"tools":["Edit","WebFetch"]}',
  ].join("\n");
};

const normalizeRoutedTools = (
  toolNames: string[],
  loadedTools: string[],
): string[] => {
  const loaded = new Set(loadedTools);
  const out: string[] = [];
  for (const toolName of toolNames) {
    if (loaded.has(toolName)) continue;
    if (toolName === "Display") {
      if (!loaded.has("DisplayGuidelines")) {
        out.push("DisplayGuidelines");
        loaded.add("DisplayGuidelines");
      }
      out.push("Display");
      loaded.add("Display");
      continue;
    }
    if (toolName === "DisplayGuidelines" && !loaded.has("Display")) {
      continue;
    }
    out.push(toolName);
    loaded.add(toolName);
  }
  return out;
};

export const getLoadableToolCatalog = (
  context: RunnerContext,
  loadedTools: string[],
): ToolMetadata[] => {
  const loaded = new Set(loadedTools);
  return context.toolHost
    .getToolCatalog()
    .filter(
      (tool) =>
        !STARTER_TOOL_SET.has(tool.name) &&
        !NON_LOADABLE_TOOL_NAMES.has(tool.name) &&
        !loaded.has(tool.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const routeToolsForPrompt = async (args: {
  context: RunnerContext;
  description: string;
  prompt: string;
  loadedTools: string[];
}): Promise<string[]> => {
  await args.context.ensureGoogleWorkspaceMcpLoaded().catch(() => undefined);
  const catalog = getLoadableToolCatalog(args.context, args.loadedTools);
  if (catalog.length === 0) {
    return [];
  }

  const resolvedLlm = resolveRunnerLlmRoute(
    args.context,
    AGENT_IDS.GENERAL,
    undefined,
  );
  const apiKey = resolvedLlm.getApiKey()?.trim();
  if (!apiKey) {
    return [];
  }

  const prompt = buildToolRouterPrompt({
    description: args.description,
    prompt: args.prompt,
    loadedTools: args.loadedTools,
    catalog,
  });

  try {
    const message = await completeSimple(
      resolvedLlm.model,
      {
        systemPrompt: TOOL_ROUTER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
      },
    );
    const raw = readAssistantText(message);
    const selected = parseSelectedTools(
      raw,
      new Set(catalog.map((tool) => tool.name)),
    );
    const normalized = normalizeRoutedTools(selected, args.loadedTools);
    logger.debug("tool-router.result", {
      description: args.description.slice(0, 120),
      loadedTools: args.loadedTools,
      selectedTools: normalized,
    });
    return normalized;
  } catch (error) {
    logger.warn("tool-router.failed", {
      description: args.description.slice(0, 120),
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};
