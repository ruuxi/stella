import { uiState } from "@/platform/ui-state"
import { isPromptId } from "./catalog"
import type { PromptId } from "./types"

const PROMPT_OVERRIDES_STORAGE_KEY = "stella.prompt-overrides.v1"
type PromptOverrideMap = Partial<Record<PromptId, string>>

const parseStoredOverrides = (raw: string | null): PromptOverrideMap => {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}

    const overrides: PromptOverrideMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!isPromptId(key) || typeof value !== "string") continue
      overrides[key] = value
    }

    return overrides
  } catch {
    return {}
  }
}

const readPromptOverrides = (): PromptOverrideMap => {
  return parseStoredOverrides(uiState.getItem(PROMPT_OVERRIDES_STORAGE_KEY))
}

export const getPromptOverride = (promptId: PromptId): string | null => {
  return readPromptOverrides()[promptId] ?? null
}
