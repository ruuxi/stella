/**
 * Discovery Types & Category Configuration
 *
 * Defines the 4 onboarding-selectable discovery categories
 * and type definitions for all signal collectors.
 */
export type DiscoveryCategory = "browsing_bookmarks" | "dev_environment" | "apps_system" | "messages_notes";
export type DiscoveryCategoryConfig = {
    id: DiscoveryCategory;
    label: string;
    description: string;
    defaultEnabled: boolean;
    requiresFDA: boolean;
};
export declare const DISCOVERY_CATEGORIES: DiscoveryCategoryConfig[];
export type BookmarkEntry = {
    title: string;
    url: string;
    folder?: string;
};
export type BrowserBookmarks = {
    browser: string;
    bookmarks: BookmarkEntry[];
    folders: string[];
};
export type SafariData = {
    history: {
        domain: string;
        visits: number;
    }[];
    bookmarks: BookmarkEntry[];
};
export type IDEExtension = {
    name: string;
    source: "vscode" | "cursor";
};
export type IDESettings = {
    source: "vscode" | "cursor";
    highlights: Record<string, string>;
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
    dotfiles: string[];
    runtimes: string[];
    packageManagers: string[];
    wslDetected: boolean;
};
export type AppUsageSummary = {
    app: string;
    durationMinutes: number;
};
export type DockPin = {
    name: string;
    path: string;
};
export type FilesystemSignals = {
    downloadsExtensions: Record<string, number>;
    documentsFolders: string[];
    desktopFileTypes: Record<string, number>;
};
export type SystemSignals = {
    dockPins: DockPin[];
    appUsage: AppUsageSummary[];
    filesystem: FilesystemSignals;
};
export type ContactFrequency = {
    identifier: string;
    displayName: string;
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
    recurringTitles: string[];
};
export type MessagesNotesSignals = {
    contacts: ContactFrequency[];
    groupChats: GroupChat[];
    noteFolders: NoteFolder[];
    calendars: CalendarSummary[];
};
export type IdentityMappingSource = "imessage" | "calendar" | "notes" | "reminders" | "git_config";
export type IdentityMapping = {
    real: {
        name: string;
        identifier: string;
    };
    alias: {
        name: string;
        identifier: string;
    };
    source: IdentityMappingSource;
};
export type IdentityMap = {
    version: 1;
    mappings: IdentityMapping[];
};
