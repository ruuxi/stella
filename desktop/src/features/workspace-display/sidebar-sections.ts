/**
 * The right sidebar's four fixed sections — Tasks, Files, Search, Apps —
 * and the "where was I" memory each one keeps.
 *
 * This sits beside `tab-store` rather than inside it because the two answer
 * different questions. `tab-store` owns the *viewer registry*: which artifact
 * specs exist and how wide the panel is. This store owns the *sidebar's
 * navigation*: which of the four sections is showing, and for each section,
 * the sub-location the user last had open. Keeping them apart means a payload
 * arriving from an agent can register a viewer without deciding anything about
 * which section the user is looking at, and the radial dial can switch sections
 * without touching the viewer registry.
 *
 * Per-section memory is the whole point of the split. Selecting a section never
 * resets it: reopening Files returns to the file you had open, reopening Apps
 * returns to the running app. Only an explicit in-section back gesture
 * (`clearLocation`) returns a section to its list.
 */

import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import { displayTabs } from "./tab-store";

export const SIDEBAR_SECTIONS = ["tasks", "files", "search", "apps"] as const;

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

export const isSidebarSection = (value: unknown): value is SidebarSection =>
  typeof value === "string" &&
  (SIDEBAR_SECTIONS as readonly string[]).includes(value);

/**
 * Per-section sub-location. `null` always means "show this section's default
 * list view".
 *
 * - `tasks` — a display-tab id for an agent-thread drill-down.
 * - `files` — a display-tab id for the open artifact.
 * - `apps`  — a user-app slug.
 * - `search` — always null; the query itself lives in `display-search-store`
 *   so the composer pill and the Search section share one query.
 */
export type SidebarSectionLocations = {
  tasks: string | null;
  files: string | null;
  search: null;
  apps: string | null;
};

export type SidebarSectionsSnapshot = {
  activeSection: SidebarSection;
  locations: SidebarSectionLocations;
};

type Listener = () => void;

const STORAGE_KEY_SECTION = "stella.sidebar.activeSection";
const STORAGE_KEY_LOCATIONS = "stella.sidebar.sectionLocations";

const DEFAULT_LOCATIONS: SidebarSectionLocations = {
  tasks: null,
  files: null,
  search: null,
  apps: null,
};

const readPersistedSection = (): SidebarSection => {
  if (typeof window === "undefined") return "tasks";
  const raw = uiState.getItem(STORAGE_KEY_SECTION);
  return isSidebarSection(raw) ? raw : "tasks";
};

/**
 * Locations are persisted as a whole object. A malformed or partial payload
 * degrades to the default list view rather than throwing — a stale id that no
 * longer resolves to a registered tab is handled at render time by the section
 * itself, which falls back to its list.
 */
const readPersistedLocations = (): SidebarSectionLocations => {
  if (typeof window === "undefined") return DEFAULT_LOCATIONS;
  const raw = uiState.getItem(STORAGE_KEY_LOCATIONS);
  if (!raw) return DEFAULT_LOCATIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_LOCATIONS;
    const record = parsed as Record<string, unknown>;
    const pick = (key: "tasks" | "files" | "apps"): string | null =>
      typeof record[key] === "string" && record[key] ? record[key] : null;
    return {
      tasks: pick("tasks"),
      files: pick("files"),
      search: null,
      apps: pick("apps"),
    };
  } catch {
    return DEFAULT_LOCATIONS;
  }
};

let snapshot: SidebarSectionsSnapshot = {
  activeSection: readPersistedSection(),
  locations: readPersistedLocations(),
};

const listeners = new Set<Listener>();

const emit = (next: SidebarSectionsSnapshot): void => {
  snapshot = next;
  for (const listener of listeners) listener();
};

const persistSection = (section: SidebarSection): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(STORAGE_KEY_SECTION, section);
};

const persistLocations = (locations: SidebarSectionLocations): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(
    STORAGE_KEY_LOCATIONS,
    JSON.stringify({
      tasks: locations.tasks,
      files: locations.files,
      apps: locations.apps,
    }),
  );
};

export const sidebarSections = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): SidebarSectionsSnapshot {
    return snapshot;
  },

  /**
   * Switch sections without touching the panel's open state. Use
   * `selectSection` for anything driven by the dial or a tab click — this is
   * for programmatic retargeting (an incoming artifact payload aiming at
   * Files, say).
   */
  setActiveSection(section: SidebarSection): void {
    if (snapshot.activeSection === section) return;
    persistSection(section);
    emit({ ...snapshot, activeSection: section });
  },

  /**
   * The open / switch / close rule the radial dial and the tab rail share.
   *
   * - panel closed          → open it on `section`
   * - panel open on X, pick X → close the panel
   * - panel open on X, pick Y → switch to Y, stay open
   *
   * Neither branch touches per-section memory, so a close/reopen round trip
   * lands back on whatever sub-location the section was showing.
   */
  selectSection(section: SidebarSection): void {
    const { panelOpen } = displayTabs.getLayoutSnapshot();

    if (!panelOpen) {
      this.setActiveSection(section);
      displayTabs.setPanelOpen(true);
      return;
    }

    if (snapshot.activeSection === section) {
      displayTabs.setPanelOpen(false);
      return;
    }

    this.setActiveSection(section);
  },

  /**
   * Record where a section is. Passing `null` returns it to its list view.
   * `search` has no sub-location and is ignored.
   */
  setLocation(section: SidebarSection, location: string | null): void {
    if (section === "search") return;
    if (snapshot.locations[section] === location) return;
    const locations = { ...snapshot.locations, [section]: location };
    persistLocations(locations);
    emit({ ...snapshot, locations });
  },

  /** Explicit in-section back: return this section to its default list. */
  clearLocation(section: SidebarSection): void {
    this.setLocation(section, null);
  },

  /**
   * Point the sidebar at a section *and* a sub-location in one step, opening
   * the panel. This is the path artifact payloads take into Files.
   */
  openLocation(section: SidebarSection, location: string | null): void {
    this.setLocation(section, location);
    this.setActiveSection(section);
    displayTabs.setPanelOpen(true);
  },

  reset(): void {
    persistSection("tasks");
    persistLocations(DEFAULT_LOCATIONS);
    emit({ activeSection: "tasks", locations: DEFAULT_LOCATIONS });
  },
};

export const useSidebarSections = (): SidebarSectionsSnapshot =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    sidebarSections.getSnapshot,
    sidebarSections.getSnapshot,
  );

export const useActiveSidebarSection = (): SidebarSection =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () => sidebarSections.getSnapshot().activeSection,
    () => sidebarSections.getSnapshot().activeSection,
  );

/** The sub-location for one section, or `null` for its list view. */
export const useSidebarSectionLocation = (
  section: SidebarSection,
): string | null =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () => sidebarSections.getSnapshot().locations[section],
    () => sidebarSections.getSnapshot().locations[section],
  );
