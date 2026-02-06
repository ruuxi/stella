import type { BrowserBookmarks } from "./discovery_types.js";
export declare function collectBrowserBookmarks(): Promise<BrowserBookmarks | null>;
export declare function formatBrowserBookmarksForSynthesis(data: BrowserBookmarks | null): string;
