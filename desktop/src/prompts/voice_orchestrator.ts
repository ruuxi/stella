import { resolvePromptText } from "./resolve"

export const getVoiceOrchestratorPrompt = (): string =>
  resolvePromptText("voice_orchestrator.base")

export const VOICE_ORCHESTRATOR_PROMPT = getVoiceOrchestratorPrompt()

export function buildVoiceSessionInstructions(context: {
  userName?: string
  platform?: string
  deviceStatus?: string
  activeThreads?: string
  userProfile?: string
}): string {
  const parts = [getVoiceOrchestratorPrompt()]

  if (context.userName) {
    parts.push(`\nThe user's name is ${context.userName}.`)
  }

  if (context.platform) {
    parts.push(`\nThe user is on ${context.platform}.`)
  }

  if (context.deviceStatus) {
    parts.push(`\n${context.deviceStatus}`)
  }

  if (context.activeThreads) {
    parts.push(`\n${context.activeThreads}`)
  }

  if (context.userProfile) {
    parts.push(`\n## User Profile\n${context.userProfile}`)
  }

  return parts.join("\n")
}
