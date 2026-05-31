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
  } else if (appId === "social") {
    preloadSocialApp();
  }
};
