import * as SecureStore from "expo-secure-store";

const GUEST_KEY = "stella-mobile_guest-mode";

let cached: boolean | null = null;

export async function loadGuestMode(): Promise<boolean> {
  if (cached !== null) return cached;
  const value = await SecureStore.getItemAsync(GUEST_KEY);
  cached = value === "1";
  return cached;
}

export async function setGuestMode(enabled: boolean): Promise<void> {
  cached = enabled;
  if (enabled) {
    await SecureStore.setItemAsync(GUEST_KEY, "1");
  } else {
    await SecureStore.deleteItemAsync(GUEST_KEY);
  }
}

export function isGuest(): boolean {
  return cached === true;
}
