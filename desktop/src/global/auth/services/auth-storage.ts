const LEGACY_STORAGE_KEYS = new Set([
  "better-auth_cookie",
  "better-auth_session_data",
]);

const clearLegacyValue = (key: string) => {
  if (!LEGACY_STORAGE_KEYS.has(key)) {
    return;
  }
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Best effort migration cleanup.
  }
};

export const desktopAuthStorage = {
  getItem(key: string): string | null {
    clearLegacyValue(key);
    return null;
  },

  setItem(key: string, value: string): void {
    void value;
    clearLegacyValue(key);
  },

  removeItem(key: string): void {
    clearLegacyValue(key);
  },
};
