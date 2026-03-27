export type MobileBridgeBootstrap = {
  localStorage: Record<string, string>;
};

const MOBILE_BRIDGE_LOCAL_STORAGE_KEYS = new Set([
  "Stella.deviceId",
  "stella-theme-id",
  "stella-color-mode",
  "stella-gradient-mode",
  "stella-gradient-color",
  "stella-onboarding-complete",
  "stella-discovery-categories",
  "stella-selected-browser",
  "stella-selected-browser-profile",
  "stella-preferred-mic-id",
  "stella-preferred-speaker-id",
  "stella-mic-enabled",
  "stella-voice-shortcut",
  "stella-media-history",
  "stella-media-form",
  "stella:orb-position",
  "stella:orb-last-seen-message",
]);

const MOBILE_BRIDGE_LOCAL_STORAGE_PREFIXES = ["better-auth"];

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
