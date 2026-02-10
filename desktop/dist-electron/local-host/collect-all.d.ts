/**
 * Collect All User Signals
 *
 * Orchestrates parallel collection of all user signal sources,
 * organized into 4 onboarding-selectable categories:
 *
 * Category 1 (browsing_bookmarks): Browser history + bookmarks + Safari
 * Category 2 (dev_environment): Dev projects + shell + git config + dotfiles
 * Category 3 (apps_system): Apps + Screen Time + Dock + filesystem
 * Category 4 (messages_notes): iMessage + Notes + Reminders + Calendar (opt-in)
 */
import type { AllUserSignals, AllUserSignalsResult } from "./types.js";
import type { DiscoveryCategory, BrowserBookmarks, SafariData, DevEnvironmentSignals, SystemSignals, MessagesNotesSignals } from "./discovery_types.js";
type ExtendedUserSignals = AllUserSignals & {
    bookmarks?: BrowserBookmarks | null;
    safari?: SafariData | null;
    devEnvironment?: DevEnvironmentSignals;
    systemSignals?: SystemSignals;
    messagesNotes?: MessagesNotesSignals;
};
/**
 * Collect all user signals in parallel, filtered by selected categories
 */
export declare const collectAllUserSignals: (StellaHome: string, categories?: DiscoveryCategory[]) => Promise<ExtendedUserSignals>;
/**
 * Format all collected data for LLM synthesis into CORE_MEMORY.
 * Category 4 output is pseudonymized before inclusion.
 */
export declare const formatAllSignalsForSynthesis: (data: ExtendedUserSignals, StellaHome: string, categories?: DiscoveryCategory[]) => Promise<string>;
/**
 * Collect and format all signals - for use in IPC handler
 */
export declare const collectAllSignals: (StellaHome: string, categories?: DiscoveryCategory[]) => Promise<AllUserSignalsResult>;
export {};
