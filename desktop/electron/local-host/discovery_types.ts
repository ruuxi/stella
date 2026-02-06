/**
 * Discovery Types & Category Configuration
 *
 * Defines the 4 onboarding-selectable discovery categories
 * and type definitions for all signal collectors.
 */

// ---------------------------------------------------------------------------
// Discovery Categories
// ---------------------------------------------------------------------------

export type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

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
    description: "IDE extensions, git config, dotfiles, runtimes, and package managers",
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

export type IDEExtension = {
  name: string;
  source: "vscode" | "cursor";
};

export type IDESettings = {
  source: "vscode" | "cursor";
  highlights: Record<string, string>; // key settings extracted
};

export type GitConfig = {
  name?: string;
  email?: string;
  defaultBranch?: string;
  aliases: string[];
};

export type DevEnvironmentSignals = {
  ideExtensions: IDEExtension[];
  ideSettings: IDESettings[];
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

export type SystemSignals = {
  dockPins: DockPin[];
  appUsage: AppUsageSummary[];
  filesystem: FilesystemSignals;
};

// ---------------------------------------------------------------------------
// Category 4: Messages & Notes
// ---------------------------------------------------------------------------

export type ContactFrequency = {
  identifier: string; // phone/email (will be pseudonymized)
  displayName: string; // contact name (will be pseudonymized)
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
  recurringTitles: string[]; // recurring event titles (pseudonymized)
};

export type MessagesNotesSignals = {
  contacts: ContactFrequency[];
  groupChats: GroupChat[];
  noteFolders: NoteFolder[];
  calendars: CalendarSummary[];
};

// ---------------------------------------------------------------------------
// Identity Map (Pseudonymization)
// ---------------------------------------------------------------------------

export type IdentityMappingSource =
  | "imessage"
  | "calendar"
  | "notes"
  | "reminders"
  | "git_config";

export type IdentityMapping = {
  real: { name: string; identifier: string };
  alias: { name: string; identifier: string };
  source: IdentityMappingSource;
};

export type IdentityMap = {
  version: 1;
  mappings: IdentityMapping[];
};
