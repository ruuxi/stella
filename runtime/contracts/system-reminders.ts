export const SYSTEM_REMINDER_TAG = "system-reminder";
export const INTERNAL_SYSTEM_REMINDER_TAG = "system_reminder";

export const wrapSystemReminder = (text: string): string =>
  `<${SYSTEM_REMINDER_TAG}>${text.trim()}</${SYSTEM_REMINDER_TAG}>`;

export const wrapInternalSystemReminder = (text: string): string =>
  `<${INTERNAL_SYSTEM_REMINDER_TAG}>${text.trim()}</${INTERNAL_SYSTEM_REMINDER_TAG}>`;

export const TASK_LIFECYCLE_WAKE_PROMPT = wrapInternalSystemReminder(
  "Continue from the latest task lifecycle update.",
);

export const formatTimestampSystemReminder = (text: string): string =>
  `<${SYSTEM_REMINDER_TAG}>${text}</${SYSTEM_REMINDER_TAG}>`;

export const formatRealtimeSystemMessage = (text: string): string =>
  `[System: ${text}]`;

export const formatAgentTerminalStateSystemReminder = (lines: string[]): string =>
  [
    `<${INTERNAL_SYSTEM_REMINDER_TAG}>`,
    "A subagent you delegated to has reached a terminal state. The block below is",
    "an internal coordination signal — the user did not see it and is not waiting",
    "on you to acknowledge it.",
    "",
    "Decide what to do next: delegate further or reply to the user.",
    `</${INTERNAL_SYSTEM_REMINDER_TAG}>`,
    "",
    ...lines,
  ].join("\n");

export const formatVoiceActionCompletedSystemReminder = (
  statusText: string,
  message: string,
): string =>
  formatRealtimeSystemMessage(
    `${statusText} Tell the user naturally and briefly: "${message}"`,
  );

export const formatVoiceActionErrorSystemReminder = (message: string): string =>
  formatRealtimeSystemMessage(
    `the action failed with error: "${message}". Let the user know briefly.`,
  );

export const formatWebSearchSystemReminder = (resultText: string): string =>
  `${formatRealtimeSystemMessage(
    resultText,
  )}\n\nSummarize these results for the user conversationally. Be concise.`;

export const formatWebSearchFailedSystemReminder = (message: string): string =>
  formatRealtimeSystemMessage(
    `Web search failed: ${message}. Let the user know briefly.`,
  );

export const formatScreenLookFailedSystemReminder = (message: string): string =>
  formatRealtimeSystemMessage(
    `I tried to look at the screen but ran into an error: ${message}. Let the user know briefly.`,
  );
