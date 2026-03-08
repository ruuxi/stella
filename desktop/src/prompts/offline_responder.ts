import { resolvePromptText } from "./resolve"

export const getOfflineResponderSystemPrompt = (): string =>
  resolvePromptText("offline_responder.system")

export const OFFLINE_RESPONDER_SYSTEM_PROMPT = getOfflineResponderSystemPrompt()
