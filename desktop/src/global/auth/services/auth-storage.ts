const LEGACY_STORAGE_KEYS = new Set([
  "better-auth_cookie",
  "better-auth_session_data",
]);

const pendingWrites = new Map<string, string | null>();

const getSystemApi = () =>
  typeof window === "undefined" ? undefined : window.electronAPI?.system;

const readLegacyValue = (key: string): string | null => {
  if (!LEGACY_STORAGE_KEYS.has(key)) {
    return null;
  }
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

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

const persist = (key: string, value: string | null) => {
  const systemApi = getSystemApi();
  if (!systemApi?.setAuthStorageItem) {
    return;
  }
  pendingWrites.set(key, value);
  void systemApi
    .setAuthStorageItem(key, value)
    .then(() => {
      if (pendingWrites.get(key) === value) {
        pendingWrites.delete(key);
      }
    })
    .catch(() => {
      // Better Auth will retry on the next session read/write.
    });
};

export const desktopAuthStorage = {
  getItem(key: string): string | null {
    const systemApi = getSystemApi();
    const pending = pendingWrites.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const stored = systemApi?.getAuthStorageItem?.(key) ?? null;
    if (stored !== null) {
      clearLegacyValue(key);
      return stored;
    }

    const legacy = readLegacyValue(key);
    if (legacy !== null) {
      persist(key, legacy);
      clearLegacyValue(key);
    }
    return legacy;
  },

  setItem(key: string, value: string): void {
    persist(key, value);
    clearLegacyValue(key);
  },

  removeItem(key: string): void {
    persist(key, null);
    clearLegacyValue(key);
  },
};
