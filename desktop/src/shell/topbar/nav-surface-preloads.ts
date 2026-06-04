import type { EmbeddedWebsiteTheme } from "@/shared/types/electron";
import { readStoredStoreTab } from "@/features/store/store-tabs";
import { readEmbeddedWebsiteTheme } from "@/global/website-view/use-embedded-website-theme";

type PreloadKey =
  | "auth"
  | "billing"
  | "connect"
  | "models-picker"
  | "settings"
  | "social"
  | "social-chat-pane"
  | "social-friends-dialog"
  | "social-new-chat-dialog"
  | "store";

const preloaded = new Set<PreloadKey>();

const runOnce = (key: PreloadKey, load: () => Promise<unknown>) => {
  if (preloaded.has(key)) return;
  preloaded.add(key);
  void load().catch(() => {
    preloaded.delete(key);
  });
};

export const preloadAuthDialog = () =>
  runOnce("auth", () => import("@/global/auth/AuthDialog"));

export const preloadBillingScreen = () =>
  runOnce("billing", () => import("@/global/billing/BillingScreen"));

export const preloadConnectDialog = () =>
  runOnce("connect", () => import("@/global/integrations/ConnectDialog"));

export const preloadModelsPicker = () =>
  runOnce("models-picker", () => import("@/global/settings/AgentModelPicker"));

// Settings owns its tab content inside the route chunk, so warming the screen
// chunk is enough to make both first open and tab switches feel immediate.
export const preloadSettingsScreen = () => {
  runOnce("settings", () => import("@/global/settings/SettingsView"));
};

export const preloadSocialApp = () =>
  runOnce("social", () => import("@/app/social/App"));

export const preloadSocialChatPane = () =>
  runOnce("social-chat-pane", () => import("@/app/social/SocialChatPane"));

export const preloadSocialFriendsDialog = () =>
  runOnce("social-friends-dialog", () => import("@/app/social/FriendsDialog"));

export const preloadSocialNewChatDialog = () =>
  runOnce("social-new-chat-dialog", () => import("@/app/social/NewChatDialog"));

export const preloadStoreApp = () =>
  runOnce("store", () => import("@/app/store/App"));

/**
 * Read the embedded theme for an offscreen prewarm without a React context.
 * The resolved color mode is reflected on `:root` as the `dark` class (see
 * `applyThemeToDocument`), and `readEmbeddedWebsiteTheme` snapshots the live
 * CSS custom properties — so the prewarmed first paint already matches the
 * desktop theme instead of flashing the website's default light gradient.
 */
const readStoreWebPrewarmTheme = (): EmbeddedWebsiteTheme => {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  return readEmbeddedWebsiteTheme(isDark ? "dark" : "light");
};

/**
 * Warm the native Store `WebContentsView` in the main process on nav-intent
 * (hover/focus of the Store sidebar entry) so the first open is an instant
 * attach rather than a cold renderer spin-up + remote fetch + hydrate.
 *
 * Deliberately NOT guarded by `runOnce`: the main process tears the view
 * down on an idle timer once Store/Billing has been closed for a while, so
 * a later hover must be able to re-warm it. The main `storeWeb:prewarm`
 * handler is idempotent (route-key guard + idempotent `ensureView`), so
 * repeat hovers while already warm are cheap no-ops.
 */
export const prewarmStoreWebView = () => {
  void window.electronAPI?.storeWeb?.prewarm?.({
    route: "store",
    tab: readStoredStoreTab(),
    embedded: true,
    theme: readStoreWebPrewarmTheme(),
  });
};

export const preloadAllNavSurfaces = () => {
  preloadAuthDialog();
  preloadBillingScreen();
  preloadConnectDialog();
  preloadModelsPicker();
  preloadSettingsScreen();
  preloadSocialApp();
  preloadSocialChatPane();
  preloadSocialFriendsDialog();
  preloadSocialNewChatDialog();
  preloadStoreApp();
};

export const preloadNavSurfaceRoute = (appId: string) => {
  if (appId === "store") {
    preloadStoreApp();
    // Store renders the embedded website webview — warm it on nav-intent so
    // the open is an instant attach, and so users who never hover Store never
    // pay for a resident webview renderer.
    prewarmStoreWebView();
  } else if (appId === "social") {
    preloadSocialApp();
  }
};
