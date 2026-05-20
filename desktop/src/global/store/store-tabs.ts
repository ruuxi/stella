/**
 * Store nav model (desktop shell routes the webview to matching `?tab=`).
 *
 * Browse/install UI lives in the embedded stella-website `/store` webview.
 * The workspace side panel handles publishing and library management.
 */

export const STORE_TAB_KEYS = ["discover", "pets", "emojis"] as const;

export type StoreTab = (typeof STORE_TAB_KEYS)[number];

type StoreTabDefinition = {
  key: StoreTab;
  label: string;
};

export const STORE_TABS: StoreTabDefinition[] = [
  { key: "discover", label: "Discover" },
  { key: "pets", label: "Pets" },
  { key: "emojis", label: "Emojis" },
];

export const DEFAULT_STORE_TAB: StoreTab = "discover";

const LEGACY_STORE_TAB_KEYS = new Set([
  "installed",
  "publish",
  "fashion",
]);

/**
 * Convert any string (URL search param, localStorage value) into a
 * valid current tab key. Legacy values map to Discover.
 */
export const normalizeStoreTab = (value: unknown): StoreTab => {
  if (typeof value !== "string") return DEFAULT_STORE_TAB;
  if (LEGACY_STORE_TAB_KEYS.has(value)) return DEFAULT_STORE_TAB;
  if ((STORE_TAB_KEYS as readonly string[]).includes(value)) {
    return value as StoreTab;
  }
  return DEFAULT_STORE_TAB;
};
