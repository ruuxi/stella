export type MobileBridgeBootstrap = {
  localStorage: Record<string, string>;
};

const MOBILE_BRIDGE_LOCAL_STORAGE_KEYS = new Set([
  "Stella.deviceId",
  "stella-theme-id",
  "stella-color-mode",
  "stella-gradient-mode",
  "stella-gradient-color",
  "stella:locale",
  "stella-onboarding-complete",
  "stella-welcome-dialog-seen",
  "stella:post-onboarding-hints",
  "stella-request-signin-after-onboarding",
  "stella-discovery-categories",
  "stella-selected-browser",
  "stella-selected-browser-profile",
  "stella.home.sidebarHintSeen",
  "stella.chatHomeSurface",
  "stella-preferred-mic-id",
  "stella-preferred-speaker-id",
  "stella-mic-enabled",
  "stella-dictation-super-fast",
  "stella-dictation-enhance",
  "stella-dictation-local",
  "stella-media-history",
  "stella-media-form",
  "stella-store-seen-blueprint-ids",
  "stella.store.lastTab",
  "stella:pet:installed",
  "stella:emoji-pack:active",
  "stella-developer-resource-previews",
  "stella:orb-position",
  "stella:orb-last-seen-message",
  "stella:feedback:bucketDay",
  "stella:feedback:activeMs",
  "stella:feedback:lastPromptAt",
]);

const MOBILE_BRIDGE_LOCAL_STORAGE_PREFIXES = [
  "stella.home.ideasSeen.v2.",
  "stella-billing-last-seen-plan:",
] as const;

const isAllowedMobileBridgeLocalStorageKey = (key: string) =>
  MOBILE_BRIDGE_LOCAL_STORAGE_KEYS.has(key)
  || MOBILE_BRIDGE_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));

export function buildMobileBridgeBootstrap(
  storage: Record<string, string>,
): MobileBridgeBootstrap {
  const localStorage: Record<string, string> = {};

  for (const [key, value] of Object.entries(storage)) {
    if (value != null && isAllowedMobileBridgeLocalStorageKey(key)) {
      localStorage[key] = value;
    }
  }

  return { localStorage };
}
