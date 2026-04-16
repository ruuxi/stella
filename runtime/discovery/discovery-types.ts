/**
 * Discovery Types & Category Configuration
 *
 * Defines the 4 onboarding-selectable discovery categories
 * and type definitions for all signal collectors.
 */

import type { DiscoveryCategory } from '../../desktop/src/shared/contracts/discovery.js'

// ---------------------------------------------------------------------------
// Discovery Categories
// ---------------------------------------------------------------------------

export type DiscoveryCategoryConfig = {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean; // macOS Full Disk Access
};

export const DISCOVERY_CATEGORIES: DiscoveryCategoryConfig[] = [
  {
    id: "browsing_bookmarks",
    label: "Browsing & Bookmarks",
    description: "Browser history, bookmarks, and saved pages",
    defaultEnabled: true,
    requiresFDA: false,
  },
  {
    id: "dev_environment",
    label: "Development Environment",
    description: "Git config, dotfiles, runtimes, and package managers",
    defaultEnabled: true,
    requiresFDA: false,
  },
  {
    id: "apps_system",
    label: "Apps & System",
    description: "App usage patterns, dock pins, and filesystem signals",
    defaultEnabled: true,
    requiresFDA: true,
  },
  {
    id: "messages_notes",
    label: "Messages & Notes",
    description: "Communication patterns, note titles, calendar density (metadata only)",
    defaultEnabled: false,
    requiresFDA: true,
  },
];

// ---------------------------------------------------------------------------
// Category 1: Browsing & Bookmarks
// ---------------------------------------------------------------------------

export type BookmarkEntry = {
  title: string;
  url: string;
  folder?: string; // parent folder name — user-created category
};

export type BrowserBookmarks = {
  browser: string;
  bookmarks: BookmarkEntry[];
  folders: string[]; // unique folder names
};

export type SafariData = {
  history: { domain: string; visits: number }[];
  bookmarks: BookmarkEntry[];
};

// ---------------------------------------------------------------------------
// Category 2: Development Environment
// ---------------------------------------------------------------------------

export type GitConfig = {
  name?: string;
  email?: string;
  defaultBranch?: string;
  aliases: string[];
};

export type DevEnvironmentSignals = {
  gitConfig: GitConfig | null;
  dotfiles: string[]; // names of dotfiles that exist
  runtimes: string[]; // names of runtimes detected
  packageManagers: string[]; // names of package managers detected
  wslDetected: boolean;
};

// ---------------------------------------------------------------------------
// Category 3: Apps & System
// ---------------------------------------------------------------------------

export type AppUsageSummary = {
  app: string;
  durationMinutes: number;
};

export type DockPin = {
  name: string;
  path: string;
};

export type FilesystemSignals = {
  downloadsExtensions: Record<string, number>; // extension → count
  documentsFolders: string[]; // top-level folder names
  desktopFileTypes: Record<string, number>; // extension → count
};

export type StartupItem = {
  name: string;
  path: string;
};

export type SystemSignals = {
  dockPins: DockPin[];
  appUsage: AppUsageSummary[];
  filesystem: FilesystemSignals;
  startupItems: StartupItem[];
};

// ---------------------------------------------------------------------------
// Category 4: Messages & Notes
// ---------------------------------------------------------------------------

export type ContactFrequency = {
  identifier: string; // phone/email
  displayName: string; // contact name
  messageCount: number;
};

export type GroupChat = {
  name: string;
  participantCount: number;
};

export type NoteFolder = {
  name: string;
  noteCount: number;
};

export type CalendarSummary = {
  calendarName: string;
  eventCount: number;
  recurringTitles: string[]; // recurring event titles
};

export type MessagesNotesSignals = {
  contacts: ContactFrequency[];
  groupChats: GroupChat[];
  noteFolders: NoteFolder[];
  calendars: CalendarSummary[];
};
