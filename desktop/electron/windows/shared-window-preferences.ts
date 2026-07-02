import type { BrowserWindowConstructorOptions } from 'electron'

type SharedWebPreferencesOptions = {
  preloadPath: string
  sessionPartition: string
  backgroundThrottling?: boolean
  /**
   * Enables the `<webview>` tag in the window's renderer. Only the full
   * shell opts in — it hosts the embedded stella.sh Store/Billing pages —
   * and every attach is vetted by `attachStoreWebviewGuards`
   * (`will-attach-webview` origin + preload enforcement).
   */
  webviewTag?: boolean
}

export const createSharedWebPreferences = ({
  preloadPath,
  sessionPartition,
  backgroundThrottling,
  webviewTag,
}: SharedWebPreferencesOptions): NonNullable<BrowserWindowConstructorOptions['webPreferences']> => ({
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  partition: sessionPartition,
  webviewTag: webviewTag ?? false,
  // Perf: make Chromium's background-throttling intent explicit instead of
  // relying on the framework default. Callers that need an always-live
  // renderer (overlay, pet) pass `false`; everyone else (full + mini shells,
  // which omit the option) gets `true` so a backgrounded shell yields CPU
  // and can't silently regress to an unthrottled state. Behavior for the
  // explicit-`false` callers is unchanged.
  backgroundThrottling: backgroundThrottling ?? true,
})
