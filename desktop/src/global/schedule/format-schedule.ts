/**
 * Small helpers for rendering schedule rows without leaking the underlying
 * cron / heartbeat shape into the UI.
 *
 * Two axes:
 *   - `formatNextRun(nextRunAtMs, nowMs)` — short right-aligned badge text
 *     for "when does this fire next" (`in 2h`, `tomorrow 9:00`, `Mon 9:00`,
 *     `Apr 14`, `now`, `due`).
 *   - `summarizeSchedule(schedule, intervalMs?)` — natural-language summary
 *     of a cron schedule definition or a heartbeat interval (`Every 30 min`,
 *     `Daily 9:00`, `Mon–Fri 9:00`, `Once at Apr 14, 9:00`). Best-effort:
 *     falls back to the raw cron expression when the pattern is too custom
 *     to summarize cheaply.
 */

import type { LocalCronSchedule } from "../../../../runtime/kernel/shared/scheduling";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const padTime = (h: number, m: number): string => {
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${hh}:${mm}`;
};

/**
 * 12-hour clock with `AM`/`PM` suffix used by the Up next badges in the
 * Chat home overview. Always includes minutes (`9:00 AM`, `9:30 AM`).
 * Hour `0` renders as `12 AM`; hour `12` renders as `12 PM`.
 */
const formatClock12 = (h: number, m: number): string => {
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}:${String(m).padStart(2, "0")} ${period}`;
};

const isSameCalendarDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Right-aligned next-run badge, e.g. `in 2h` or `Mon 9:00`. */
export const formatNextRun = (nextRunAtMs: number, nowMs: number): string => {
  if (!Number.isFinite(nextRunAtMs)) return "";
  const delta = nextRunAtMs - nowMs;
  if (delta <= -MINUTE_MS) return "due";
  if (delta < MINUTE_MS) return "now";
  if (delta < HOUR_MS) {
    const mins = Math.round(delta / MINUTE_MS);
    return `in ${mins}m`;
  }
  if (delta < 6 * HOUR_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    const mins = Math.round((delta - hours * HOUR_MS) / MINUTE_MS);
    return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  }

  const next = new Date(nextRunAtMs);
  const now = new Date(nowMs);
  if (isSameCalendarDay(next, now)) {
    return formatClock12(next.getHours(), next.getMinutes());
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameCalendarDay(next, tomorrow)) {
    return `tomorrow ${formatClock12(next.getHours(), next.getMinutes())}`;
  }
  if (delta < 7 * DAY_MS) {
    return `${SHORT_WEEKDAYS[next.getDay()]} ${formatClock12(next.getHours(), next.getMinutes())}`;
  }
  return `${SHORT_MONTHS[next.getMonth()]} ${next.getDate()}`;
};

const formatIntervalEvery = (everyMs: number): string => {
  if (everyMs >= DAY_MS && everyMs % DAY_MS === 0) {
    const days = everyMs / DAY_MS;
    return days === 1 ? "Daily" : `Every ${days} days`;
  }
  if (everyMs >= HOUR_MS && everyMs % HOUR_MS === 0) {
    const hours = everyMs / HOUR_MS;
    return hours === 1 ? "Hourly" : `Every ${hours}h`;
  }
  const minutes = Math.max(1, Math.round(everyMs / MINUTE_MS));
  return `Every ${minutes} min`;
};

const WEEKDAY_FIELD_REGEX = /^([0-7])(?:[,-]([0-7]))?$/;
const isAllOrStar = (value: string): boolean => value === "*" || value === "?";

const parseClockTimeFromCron = (
  minute: string,
  hour: string,
): { h: number; m: number } | null => {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
};

const summarizeCron = (expr: string): string => {
  const parts = expr.trim().split(/\s+/);
  // Accept both 5-field (m h dom mon dow) and 6-field (s m h dom mon dow) forms.
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  if (fields.length !== 5) return expr;
  const [minute, hour, dom, mon, dow] = fields;
  const time = parseClockTimeFromCron(minute, hour);
  const everyDom = isAllOrStar(dom);
  const everyMon = isAllOrStar(mon);
  if (!time || !everyMon) return expr;
  const clock = padTime(time.h, time.m);

  if (everyDom && isAllOrStar(dow)) {
    return `Daily ${clock}`;
  }

  if (everyDom) {
    const match = dow.match(WEEKDAY_FIELD_REGEX);
    if (match) {
      const start = Number(match[1]) % 7;
      const end = match[2] !== undefined ? Number(match[2]) % 7 : start;
      if (dow.includes(",")) {
        const days = dow
          .split(",")
          .map((value) => Number(value) % 7)
          .filter((value) => Number.isFinite(value));
        if (days.length > 0 && days.every((value) => value >= 0 && value <= 6)) {
          const labels = days.map((value) => SHORT_WEEKDAYS[value]);
          return `${labels.join(", ")} ${clock}`;
        }
      }
      if (start === end) {
        return `${SHORT_WEEKDAYS[start]} ${clock}`;
      }
      return `${SHORT_WEEKDAYS[start]}–${SHORT_WEEKDAYS[end]} ${clock}`;
    }
    if (dow === "1-5" || dow === "MON-FRI") return `Weekdays ${clock}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends ${clock}`;
  }

  return expr;
};

/**
 * Natural-language one-liner for a schedule shape. Pass `intervalMs` for
 * heartbeats (which don't have a `LocalCronSchedule` — they're "every N ms").
 */
export const summarizeSchedule = (
  schedule: LocalCronSchedule | null | undefined,
  intervalMs?: number,
): string => {
  if (!schedule) {
    if (typeof intervalMs === "number" && intervalMs > 0) {
      return formatIntervalEvery(intervalMs);
    }
    return "";
  }
  if (schedule.kind === "every") return formatIntervalEvery(schedule.everyMs);
  if (schedule.kind === "at") {
    const date = new Date(schedule.atMs);
    return `Once at ${SHORT_MONTHS[date.getMonth()]} ${date.getDate()}, ${padTime(date.getHours(), date.getMinutes())}`;
  }
  return summarizeCron(schedule.expr);
};
