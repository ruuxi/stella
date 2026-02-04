import { getElectronApi } from "./electron";

const DEVICE_ID_KEY = "Stella.deviceId";

let cachedDeviceId: string | null = null;

const readLocalDeviceId = () => {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(DEVICE_ID_KEY);
};

const writeLocalDeviceId = (deviceId: string) => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
};

const generateFallbackDeviceId = () => {
  const fallback = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return fallback;
};

export const configureLocalHost = async () => {
  const api = getElectronApi();
  const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!api?.configureHost || !convexUrl) {
    return;
  }
  try {
    const response = await api.configureHost({ convexUrl });
    if (response?.deviceId) {
      cachedDeviceId = response.deviceId;
      writeLocalDeviceId(response.deviceId);
    }
  } catch {
    // Ignore configuration failures; the renderer can still function locally.
  }
};

export const getOrCreateDeviceId = async () => {
  if (cachedDeviceId) {
    return cachedDeviceId;
  }

  const api = getElectronApi();
  if (api?.getDeviceId) {
    try {
      const fromHost = await api.getDeviceId();
      if (fromHost) {
        cachedDeviceId = fromHost;
        writeLocalDeviceId(fromHost);
        return fromHost;
      }
    } catch {
      // Fall through to local fallback.
    }
  }

  const existing = readLocalDeviceId();
  if (existing) {
    cachedDeviceId = existing;
    return existing;
  }

  const created = generateFallbackDeviceId();
  cachedDeviceId = created;
  writeLocalDeviceId(created);
  return created;
};

export const getCachedDeviceId = () => cachedDeviceId ?? readLocalDeviceId();
