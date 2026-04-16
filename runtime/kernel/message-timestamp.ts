/** Shared timestamp utilities for message tagging. */

const TIME_PATTERN =
  "(?:1[0-2]|0?[1-9]):[0-5]\\d\\s?(?:AM|PM)(?:,\\s+[A-Za-z]{3}\\s+\\d{1,2})?";

/** Matches a leading `[time]` or `<system-reminder>time</system-reminder>` tag. */
export const LEADING_TIME_TAG_RE = new RegExp(
  `^(?:\\[${TIME_PATTERN}\\]|<system-reminder>${TIME_PATTERN}<\\/system-reminder>)\\s*`,
  "i",
);

/** Matches a trailing `\n\n[time]` or `\n\n<system-reminder>time</system-reminder>` tag. */
export const TRAILING_TIME_TAG_RE = new RegExp(
  `\\s*\\n\\n(?:\\[${TIME_PATTERN}\\]|<system-reminder>${TIME_PATTERN}<\\/system-reminder>)$`,
  "i",
);

export const TEN_MINUTES_MS = 10 * 60 * 1000;
export const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export const wrapSystemReminder = (text: string): string =>
  `<system-reminder>${text.trim()}</system-reminder>`;

export const formatDateTimeReminder = (
  timestamp: number,
  timezone?: string,
): string => {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const value = new Date(timestamp).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  return `Current date and time: ${value}.`;
};

/**
 * Format a timestamp tag for appending to a user message.
 * Always includes the date portion.
 */
export const formatTimestampTag = (timestamp: number, timezone?: string): string => {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const d = new Date(timestamp);
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  return `<system-reminder>${timeStr}, ${dateStr}</system-reminder>`;
};

/**
 * Format a timestamp for history building. Omits the date when it matches prevDate.
 */
export const formatTimestampForHistory = (
  timestamp: number,
  prevDate?: string,
  timezone?: string,
): { tag: string; dateStr: string } => {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const d = new Date(timestamp);
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  const tag =
    prevDate && dateStr === prevDate
      ? `<system-reminder>${timeStr}</system-reminder>`
      : `<system-reminder>${timeStr}, ${dateStr}</system-reminder>`;
  return { tag, dateStr };
};
