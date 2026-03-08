import { resolvePromptText } from "./resolve"
import type { PersonalizedDashboardPageAssignment } from "./types"

export type { PersonalizedDashboardPageAssignment } from "./types"

export const getPersonalizedDashboardPageSystemPrompt = (): string =>
  resolvePromptText("personalized_dashboard.system")

export const PERSONALIZED_DASHBOARD_PAGE_SYSTEM_PROMPT =
  getPersonalizedDashboardPageSystemPrompt()

export const buildPersonalizedDashboardPageUserMessage = (args: {
  userProfile: string
  assignment: PersonalizedDashboardPageAssignment
}) => resolvePromptText("personalized_dashboard.user", args)
