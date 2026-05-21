type PreloadKey =
  | "auth"
  | "billing"
  | "connect"
  | "models-picker"
  | "settings"
  | "settings-general"
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

// Settings opens to GeneralTab by default (`?tab=` is the override). Warming
// both the shell and GeneralTab in the same preload kills the brief Suspense
// flash users would otherwise see for the active tab on first open.
export const preloadSettingsScreen = () => {
  runOnce("settings", () => import("@/global/settings/SettingsView"));
  runOnce(
    "settings-general",
    () => import("@/global/settings/tabs/GeneralTab"),
  );
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

export const preloadAllSidebarSurfaces = () => {
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

export const preloadSidebarRoute = (appId: string) => {
  if (appId === "store") {
    preloadStoreApp();
  } else if (appId === "social") {
    preloadSocialApp();
  }
};
