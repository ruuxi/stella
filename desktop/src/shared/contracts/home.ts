export type RecentApp = {
  /** Display name (e.g. "Cursor", "Google Chrome"). */
  name: string;
  /** Bundle id (e.g. "com.google.Chrome") when available. */
  bundleId?: string;
  /** OS process id. Useful for de-duplication and as a stable React key. */
  pid: number;
  /** True when this is the frontmost app at the time of the snapshot. */
  isActive: boolean;
  /**
   * Topmost on-screen window title for this app, when available. Empty
   * string when the app has no titled window or the platform/permission
   * didn't expose it. Renderer uses this to show "Cursor — README.md"
   * style chips instead of just the bare app name.
   */
  windowTitle?: string;
};

export type ListRecentAppsResult = {
  apps: RecentApp[];
};

/**
 * Active tab snapshot for a known browser. Captured by querying the browser
 * via AppleScript (mac) or the bundled extension bridge (windows). Renderer
 * uses this to show a "+ <site> in <Browser>" chip.
 */
export type ActiveBrowserTab = {
  /** Display name of the browser (e.g. "Brave Browser", "Arc"). */
  browser: string;
  /** Bundle id of the browser, when known. */
  bundleId?: string;
  /** Full URL of the active tab. Always non-empty when present. */
  url: string;
  /** Page title of the active tab, if available. */
  title?: string;
};

export type GetActiveBrowserTabResult = {
  tab: ActiveBrowserTab | null;
};
