import { PROMPT_IDS, isPromptId } from "./catalog"
import type { PromptId, PromptOverrideMap } from "./types"

const PROMPT_OVERRIDES_STORAGE_KEY = "stella.prompt-overrides.v1"

const getLocalStorage = (): Storage | null => {
  if (typeof window === "undefined") return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

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

export const readPromptOverrides = (): PromptOverrideMap => {
  const storage = getLocalStorage()
  if (!storage) return {}

  return parseStoredOverrides(storage.getItem(PROMPT_OVERRIDES_STORAGE_KEY))
}

export const loadPromptOverrides = (): PromptOverrideMap => readPromptOverrides()

export const writePromptOverrides = (overrides: PromptOverrideMap): PromptOverrideMap => {
  const storage = getLocalStorage()
  const nextOverrides: PromptOverrideMap = {}

  for (const promptId of PROMPT_IDS) {
    const value = overrides[promptId]
    if (typeof value === "string") {
      nextOverrides[promptId] = value
    }
  }

  if (storage) {
    storage.setItem(PROMPT_OVERRIDES_STORAGE_KEY, JSON.stringify(nextOverrides))
  }

  return nextOverrides
}

export const getPromptOverride = (promptId: PromptId): string | null => {
  return readPromptOverrides()[promptId] ?? null
}

export const setPromptOverride = (promptId: PromptId, text: string): PromptOverrideMap => {
  const overrides = readPromptOverrides()
  overrides[promptId] = text
  return writePromptOverrides(overrides)
}

export const resetPromptOverride = (promptId: PromptId): PromptOverrideMap => {
  const overrides = readPromptOverrides()
  delete overrides[promptId]
  return writePromptOverrides(overrides)
}

export const resetPromptOverrides = (): void => {
  const storage = getLocalStorage()
  if (!storage) return

  storage.removeItem(PROMPT_OVERRIDES_STORAGE_KEY)
}
