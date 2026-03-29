import { getPromptTemplateText } from "./resolve";
import {
  TOOL_DESCRIPTIONS,
  TOOL_JSON_SCHEMAS,
} from "../../packages/runtime-kernel/tools/schemas";

type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const VOICE_ORCHESTRATOR_TOOL_NAMES = [
  "Display",
  "DisplayGuidelines",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  "Schedule",
  "TaskCreate",
  "TaskUpdate",
  "TaskCancel",
  "TaskOutput",
  "SaveMemory",
  "RecallMemories",
];

export const getVoiceToolSchemas = (): VoiceToolSchema[] => {
  const tools: VoiceToolSchema[] = VOICE_ORCHESTRATOR_TOOL_NAMES.map(
    (name) => ({
      type: "function" as const,
      name,
      description: TOOL_DESCRIPTIONS[name] ?? `${name} tool`,
      parameters: (TOOL_JSON_SCHEMAS[name] ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>,
    }),
  );

  tools.push({
    type: "function",
    name: "goodbye",
    description:
      "End the voice conversation. Call this when the user says goodbye, bye, see you later, goodnight, or otherwise indicates they want to stop talking.",
    parameters: { type: "object", properties: {} },
  });

  return tools;
};

export const getVoiceSessionPromptConfig = (): {
  basePrompt: string;
  tools: VoiceToolSchema[];
} => ({
  basePrompt: getPromptTemplateText("voice_orchestrator.base").trim(),
  tools: getVoiceToolSchemas(),
})

export const getSynthesisPromptConfig = () => ({
  categoryAnalysisSystemPrompts: {
    browsing_bookmarks: getPromptTemplateText("synthesis.category_analysis.browsing_bookmarks.system").trim(),
    dev_environment: getPromptTemplateText("synthesis.category_analysis.dev_environment.system").trim(),
    apps_system: getPromptTemplateText("synthesis.category_analysis.apps_system.system").trim(),
    messages_notes: getPromptTemplateText("synthesis.category_analysis.messages_notes.system").trim(),
  } as Record<string, string>,
  categoryAnalysisUserPromptTemplate: getPromptTemplateText("synthesis.category_analysis.user").trim(),
  coreMemorySystemPrompt: getPromptTemplateText("synthesis.core_memory.system").trim(),
  coreMemoryUserPromptTemplate: getPromptTemplateText("synthesis.core_memory.user").trim(),
  welcomeMessagePromptTemplate: getPromptTemplateText("synthesis.welcome_message.user").trim(),
  homeSuggestionsPromptTemplate: getPromptTemplateText("synthesis.home_suggestions.user").trim(),
})

export const getSkillMetadataPromptConfig = () => ({
  systemPrompt: getPromptTemplateText("skill_metadata.system").trim(),
  userPromptTemplate: getPromptTemplateText("skill_metadata.user").trim(),
})

export const getSkillSelectionPromptConfig = () => ({
  systemPrompt: getPromptTemplateText("skill_selection.system").trim(),
  userPromptTemplate: getPromptTemplateText("skill_selection.user").trim(),
})

