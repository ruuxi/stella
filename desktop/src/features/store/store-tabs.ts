/**
 * Store nav model.
 *
 * The Store has two top-level destinations:
 *   - "Discover" — browse + install add-ons. The Store side panel
 *     (in the workspace panel) handles publishing, updating, and
 *     library management — there is no separate "Installed" or
 *     "Publish" tab anymore.
 *   - "Fashion" — Shopify try-on flow.
 */

export const STORE_TAB_KEYS = [
  "discover",
  "pets",
  "emojis",
  "fashion",
] as const;

export type StoreTab = (typeof STORE_TAB_KEYS)[number];

type StoreTabDefinition = {
  key: StoreTab;
  label: string;
};

export const STORE_TABS: StoreTabDefinition[] = [
  { key: "discover", label: "Discover" },
  { key: "pets", label: "Pets" },
  { key: "emojis", label: "Emojis" },
  { key: "fashion", label: "Fashion" },
];

export const DEFAULT_STORE_TAB: StoreTab = "discover";

const LEGACY_STORE_TAB_KEYS = new Set(["installed", "publish"]);

/**
 * Convert any string (URL search param, localStorage value) into a
 * valid current tab key. Legacy values (`"installed"`, `"publish"`)
 * map to Discover; everything unknown also falls back to Discover.
 */
export const normalizeStoreTab = (value: unknown): StoreTab => {
  if (typeof value !== "string") return DEFAULT_STORE_TAB;
  if (LEGACY_STORE_TAB_KEYS.has(value)) return DEFAULT_STORE_TAB;
  if ((STORE_TAB_KEYS as readonly string[]).includes(value)) {
    return value as StoreTab;
  }
  return DEFAULT_STORE_TAB;
};

/**
 * localStorage key for the last-active Store tab. The URL `?tab=` param is
 * the source of truth while inside Store; this persists across visits so
 * reopening Store lands where the user left off, and lets the warm-up path
 * preload the same tab the open will land on (so the prewarmed view isn't
 * thrown away by a route-key mismatch).
 */
export const LAST_STORE_TAB_KEY = "stella.store.lastTab";

export const readStoredStoreTab = (): StoreTab => {
  try {
    return normalizeStoreTab(window.localStorage?.getItem(LAST_STORE_TAB_KEY));
  } catch {
    return DEFAULT_STORE_TAB;
  }
};
