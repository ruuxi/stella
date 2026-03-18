import { resolvePromptText } from "./resolve"

export const getSkillMetadataPrompt = (): string => resolvePromptText("skill_metadata.system")

export const SKILL_METADATA_PROMPT = getSkillMetadataPrompt()

export const buildSkillMetadataUserMessage = (
  skillDirName: string,
  markdown: string,
): string => resolvePromptText("skill_metadata.user", { skillDirName, markdown })
