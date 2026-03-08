import { resolvePromptText } from "./resolve"
import type { SkillCatalogItem } from "./types"

export type { SkillCatalogItem } from "./types"

export const getSkillSelectionPrompt = (): string =>
  resolvePromptText("skill_selection.system")

export const SKILL_SELECTION_PROMPT = getSkillSelectionPrompt()

export const buildSkillSelectionUserMessage = (
  userProfile: string,
  catalog: SkillCatalogItem[],
): string => resolvePromptText("skill_selection.user", { userProfile, catalog })
