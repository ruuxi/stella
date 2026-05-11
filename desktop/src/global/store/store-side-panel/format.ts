import type { StoreCategory } from "./types";

const STORE_CATEGORIES: ReadonlySet<StoreCategory> = new Set([
  "apps-games",
  "productivity",
  "customization",
  "skills-agents",
  "integrations",
  "other",
]);

const isStoreCategory = (value: string | null | undefined): value is StoreCategory =>
  typeof value === "string" && STORE_CATEGORIES.has(value as StoreCategory);

/**
 * Slug a free-form name into a backend-acceptable package ID. Mirrors the
 * server's `PACKAGE_ID_PATTERN` (`^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`)
 * so the publish action accepts whatever we generate without a round-trip
 * for ID validation.
 */
export function packageIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Pull the publish-form pre-fill values from the structured metadata
 * header the Store agent writes into every blueprint draft:
 *   # <Name>
 *   > <Description>
 *   Category: <one of: apps-games | productivity | …>
 *
 * Each field is best-effort: a missing or malformed line yields an empty
 * string / null so the dialog can still open and let the user fill in
 * whatever the agent failed to provide.
 */
export function parseBlueprintMetadata(text: string): {
  name: string;
  description: string;
  category: StoreCategory | null;
} {
  const nameMatch = text.match(/^\s*#\s+(.+?)\s*$/m);
  const name = nameMatch?.[1]?.trim() ?? "";

  // First blockquote near the top — collapse `> a\n> b` into one line.
  const descMatch = text.match(/^\s*>\s+([^\n]+(?:\n>\s+[^\n]+)*)/m);
  const description = descMatch?.[1]
    ? descMatch[1].replace(/\n>\s+/g, " ").trim()
    : "";

  // `Category: <value>` (allow optional bold/code emphasis).
  const catMatch = text.match(
    /(?:^|\n)\s*(?:\*\*|`)?\s*Category\s*(?:\*\*|`)?\s*:\s*(?:\*\*|`)?([a-z][a-z-]*)/i,
  );
  const rawCategory = catMatch?.[1]?.toLowerCase().trim() ?? null;
  const category = isStoreCategory(rawCategory) ? rawCategory : null;

  return { name, description, category };
}

export function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Pull a friendly blueprint name from the leading `# Heading` of the
 * markdown, falling back to "Blueprint" if there isn't one. Keeps the
 * pill's secondary line readable without inventing a separate field.
 */
export function deriveBlueprintName(text: string): string {
  const match = text.match(/^\s*#\s+(.+?)\s*$/m);
  if (match && match[1]) return match[1].trim();
  return "Blueprint";
}

export function fireBlueprintNotification(
  messageId: string,
  name: string,
): void {
  try {
    void window.electronAPI?.store?.showBlueprintNotification?.({
      messageId,
      name,
    });
  } catch {
    // ignore — best-effort OS notification
  }
}
