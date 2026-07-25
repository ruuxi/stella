/**
 * Presentation-free pieces of the user-app library: the search/sort rule, the
 * "created" stamp, and the prompt that asks Stella for a new app.
 *
 * Two surfaces render the library — the Apps sidebar section and the `/apps`
 * page kept for window types without the panel — and they differ only in
 * layout. Keeping the rules here is what stops the two from drifting into
 * different sort orders for the same list.
 */

import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { dispatchComposeText } from "@/shared/lib/stella-orb-chat";
import type { UserApp } from "@/app/_user/user-apps-registry";

export type UserAppSort = "recent" | "name";

export const USER_APP_SORT_LABELS: Record<UserAppSort, string> = {
  recent: "Most recent",
  name: "Name",
};

export const isUserAppSort = (value: string): value is UserAppSort =>
  value === "recent" || value === "name";

const RELATIVE_UNITS: ReadonlyArray<{
  ms: number;
  unit: Intl.RelativeTimeFormatUnit;
}> = [
  { ms: 60 * 1000, unit: "second" },
  { ms: 60 * 60 * 1000, unit: "minute" },
  { ms: 24 * 60 * 60 * 1000, unit: "hour" },
  { ms: 7 * 24 * 60 * 60 * 1000, unit: "day" },
  { ms: 30 * 24 * 60 * 60 * 1000, unit: "week" },
  { ms: 365 * 24 * 60 * 60 * 1000, unit: "month" },
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export function formatUserAppCreatedAt(iso: string): string {
  const created = new Date(iso).getTime();
  if (!Number.isFinite(created)) return "";
  const diff = created - Date.now();
  const abs = Math.abs(diff);
  for (let i = 0; i < RELATIVE_UNITS.length - 1; i++) {
    const current = RELATIVE_UNITS[i]!;
    const next = RELATIVE_UNITS[i + 1]!;
    if (abs < next.ms) {
      return relativeTimeFormatter.format(
        Math.round(diff / current.ms),
        current.unit,
      );
    }
  }
  const last = RELATIVE_UNITS[RELATIVE_UNITS.length - 1]!;
  return relativeTimeFormatter.format(Math.round(diff / last.ms), last.unit);
}

/** Apps matching `query` (label or slug), in `sort` order. */
export function listUserApps(
  apps: readonly UserApp[],
  query: string,
  sort: UserAppSort,
): readonly UserApp[] {
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? apps.filter(
        (app) =>
          app.meta.label.toLowerCase().includes(trimmed) ||
          app.slug.toLowerCase().includes(trimmed),
      )
    : apps.slice();
  if (sort === "name") {
    filtered.sort((a, b) => a.meta.label.localeCompare(b.meta.label));
  } else {
    filtered.sort((a, b) => {
      const at = Date.parse(a.meta.createdAt);
      const bt = Date.parse(b.meta.createdAt);
      const av = Number.isFinite(at) ? at : 0;
      const bv = Number.isFinite(bt) ? bt : 0;
      return bv - av;
    });
  }
  return filtered;
}

const CREATE_APP_PROMPT = "Tell me what stella apps can you make for me?";

/**
 * Hand the user to chat with the "what can you build me" prompt already in the
 * composer. The compose event only lands on a mounted composer, so the
 * navigation has to settle first.
 */
export function useRequestUserApp(): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    void navigate({ to: "/chat" }).then(() => {
      requestAnimationFrame(() => {
        dispatchComposeText({ text: CREATE_APP_PROMPT });
      });
    });
  }, [navigate]);
}
