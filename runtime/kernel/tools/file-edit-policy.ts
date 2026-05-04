import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { Api, Model } from "../../ai/types.js";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";
export const WRITE_TOOL_NAME = "Write";
export const EDIT_TOOL_NAME = "Edit";
export const WRITE_EDIT_TOOL_NAMES = [WRITE_TOOL_NAME, EDIT_TOOL_NAME] as const;

export type FileEditToolFamily = "apply_patch" | "write_edit";

type ModelIdentity = Pick<Model<Api>, "api" | "provider" | "id" | "name">;

const hasOpenAiPrefix = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "openai" ||
    normalized === "openai-codex" ||
    normalized.startsWith("openai/") ||
    normalized.startsWith("stella/openai/") ||
    normalized.startsWith("azure-openai")
  );
};

export const isOpenAiAuthoredModel = (model?: ModelIdentity | null): boolean => {
  if (!model) {
    return true;
  }
  if (
    hasOpenAiPrefix(model.provider) ||
    hasOpenAiPrefix(model.api) ||
    hasOpenAiPrefix(model.id)
  ) {
    return true;
  }
  const id = model.id.trim().toLowerCase();
  return (
    id.startsWith("gpt-") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4")
  );
};

export const getFileEditToolFamily = (args: {
  agentType?: string;
  model?: ModelIdentity | null;
}): FileEditToolFamily => {
  if (!args.agentType || args.agentType === AGENT_IDS.ORCHESTRATOR) {
    return "apply_patch";
  }
  return isOpenAiAuthoredModel(args.model) ? "apply_patch" : "write_edit";
};

export const rewriteFileEditToolNames = (
  toolNames: readonly string[] | undefined,
  family: FileEditToolFamily,
): string[] | undefined => {
  if (!Array.isArray(toolNames)) {
    return undefined;
  }
  const rewritten: string[] = [];
  const seen = new Set<string>();
  const add = (toolName: string) => {
    if (seen.has(toolName)) return;
    seen.add(toolName);
    rewritten.push(toolName);
  };

  for (const toolName of toolNames) {
    if (family === "write_edit" && toolName === APPLY_PATCH_TOOL_NAME) {
      for (const replacement of WRITE_EDIT_TOOL_NAMES) {
        add(replacement);
      }
      continue;
    }
    if (
      family === "apply_patch" &&
      (toolName === WRITE_TOOL_NAME || toolName === EDIT_TOOL_NAME)
    ) {
      add(APPLY_PATCH_TOOL_NAME);
      continue;
    }
    add(toolName);
  }

  return rewritten;
};

