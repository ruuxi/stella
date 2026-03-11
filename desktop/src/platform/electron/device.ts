import { getElectronApi } from "./electron";

const DEVICE_ID_KEY = "Stella.deviceId";

let cachedDeviceId: string | null = null;

const readLocalDeviceId = () => {
  return window.localStorage.getItem(DEVICE_ID_KEY);
};

const writeLocalDeviceId = (deviceId: string) => {
  window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
};

const generateFallbackDeviceId = () => {
  return crypto.randomUUID();
};

export const configurePiRuntime = async () => {
  const api = getElectronApi();
  const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!api?.system?.configurePiRuntime || !convexUrl) {
    return;
  }
  try {
    const convexSiteUrl =
      (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined)
      ?? (import.meta.env.VITE_CONVEX_HTTP_URL as string | undefined)
      ?? convexUrl.replace(".convex.cloud", ".convex.site");
    const response = await api.system.configurePiRuntime({ convexUrl, convexSiteUrl });
    if (response?.deviceId) {
      cachedDeviceId = response.deviceId;
      writeLocalDeviceId(response.deviceId);
    }
  } catch (err) {
    console.debug("[device] configurePiRuntime failed:", (err as Error).message);
  }
};

export const getOrCreateDeviceId = async () => {
  if (cachedDeviceId) {
    return cachedDeviceId;
  }

  const api = getElectronApi();
  if (api?.system?.getDeviceId) {
    try {
      const fromHost = await api.system.getDeviceId();
      if (fromHost) {
        cachedDeviceId = fromHost;
        writeLocalDeviceId(fromHost);
        return fromHost;
      }
    } catch (err) {
      console.debug("[device] getDeviceId from host failed:", (err as Error).message);
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
