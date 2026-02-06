/**
 * Safari Data Collection
 *
 * Reads Safari browser history and bookmarks on macOS.
 * Requires Full Disk Access for both History.db and Bookmarks.plist.
 */
import type { SafariData, BookmarkEntry } from "./discovery_types.js";
/**
 * Collect Safari browsing history (last 7 days)
 * Requires Full Disk Access to read ~/Library/Safari/History.db
 */
export declare const collectSafariHistory: (stellaHome: string) => Promise<{
    domain: string;
    visits: number;
}[]>;
/**
 * Collect Safari bookmarks from Bookmarks.plist
 * Requires Full Disk Access to read ~/Library/Safari/Bookmarks.plist
 */
export declare const collectSafariBookmarks: () => Promise<BookmarkEntry[]>;
/**
 * Collect Safari history and bookmarks
 */
export declare const collectSafariData: (stellaHome: string) => Promise<SafariData | null>;
/**
 * Format Safari data for LLM synthesis input
 */
export declare const formatSafariDataForSynthesis: (data: SafariData | null) => string;
