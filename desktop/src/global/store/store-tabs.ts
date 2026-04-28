/**
 * Store nav model.
 *
 * The Store screen has two distinct universes:
 *   - "Stella Store"  — things that change Stella itself (mods, integrations).
 *   - "Shop"          — actual shopping surfaces (Fashion today, more later).
 *
 * Each tab is a single PageSidebar entry, grouped under a section label so
 * the user reads the universe split before the individual destination —
 * mirroring how Apple's Music sidebar separates Library from Apple Music.
 */

export const STORE_TAB_KEYS = ["discover", "installed", "fashion"] as const;

export type StoreTab = (typeof STORE_TAB_KEYS)[number];

export type StoreTabGroup = "stella-store" | "shop";

export const STORE_TAB_GROUP_LABELS: Record<StoreTabGroup, string> = {
  "stella-store": "Stella Store",
  shop: "Shop",
};

export type StoreTabDefinition = {
  key: StoreTab;
  label: string;
  group: StoreTabGroup;
};

/**
 * Discover folds in Integrations (a section of bonus things to add), and
 * Installed folds in Updates (a section above your library when items have
 * a newer release). The list stays at three top-level destinations so the
 * sidebar reads as decisively as the App Store's left rail.
 */
export const STORE_TABS: StoreTabDefinition[] = [
  { key: "discover", label: "Discover", group: "stella-store" },
  { key: "installed", label: "Installed", group: "stella-store" },
  { key: "fashion", label: "Fashion", group: "shop" },
];

export const STORE_TAB_GROUP_ORDER: StoreTabGroup[] = ["stella-store", "shop"];

export const DEFAULT_STORE_TAB: StoreTab = "discover";
