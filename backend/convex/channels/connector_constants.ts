/**
 * Shared connector message-size limits and truncation helper.
 *
 * Every connector file and connector_delivery.ts imports from here
 * instead of defining its own copy.
 */

// ─── Connector Message Length Limits ──────────────────────────────────────────
export const SLACK_MAX_MESSAGE_CHARS = 40_000;
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
export const DISCORD_MAX_MESSAGE_CHARS = 2000;
export const GOOGLE_CHAT_MAX_MESSAGE_CHARS = 4096;
export const TEAMS_MAX_MESSAGE_CHARS = 28_000;

/** Truncate text to fit a connector's message-size limit, appending a suffix when clipped. */
export const truncateForConnector = (text: string, maxLen: number): string =>
  text.length > maxLen
    ? text.slice(0, maxLen - 20) + "\n\n... (truncated)"
    : text;
