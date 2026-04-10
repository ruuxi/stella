import * as SecureStore from "expo-secure-store";

const CONSENT_KEY = "stella-mobile_ai-data-consent";

let cached: boolean | null = null;

export async function loadAiConsent(): Promise<boolean> {
  if (cached !== null) return cached;
  const value = await SecureStore.getItemAsync(CONSENT_KEY);
  cached = value === "1";
  return cached;
}

export async function grantAiConsent(): Promise<void> {
  cached = true;
  await SecureStore.setItemAsync(CONSENT_KEY, "1");
}

export function hasAiConsent(): boolean {
  return cached === true;
}
