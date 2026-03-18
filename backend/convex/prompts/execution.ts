export const BACKEND_JOB_MODE_SYSTEM_NOTICE =
  "<system-notice>You are running in backend job mode. Local device tools (file system, shell, browser, apps, and direct user prompts) are unavailable in this run, even if a desktop is online. Use only backend-safe tools and explain when a request requires the user's desktop.</system-notice>";

export const buildBackendJobModeSystemPrompt = (systemPrompt: string): string =>
  `${systemPrompt}\n\n${BACKEND_JOB_MODE_SYSTEM_NOTICE}`;
