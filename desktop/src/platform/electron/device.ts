import { getElectronApi } from "./electron";
import {
  readConfiguredConvexSiteUrl,
  readConfiguredConvexUrl,
} from "@/shared/lib/convex-urls";

const DEVICE_ID_KEY = "Stella.deviceId";

let cachedDeviceId: string | null = null;

const writeLocalDeviceId = (deviceId: string) => {
  window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
};

export const configurePiRuntime = async () => {
  const api = getElectronApi();
  const convexUrl = readConfiguredConvexUrl(
    import.meta.env.VITE_CONVEX_URL as string | undefined,
  );
  const convexSiteUrl = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!api?.system?.configurePiRuntime || !convexUrl || !convexSiteUrl) {
    return;
  }
  try {
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
  if (!api?.system?.getDeviceId) {
    throw new Error("Stella device identity is unavailable.");
  }

  const fromHost = await api.system.getDeviceId();
  if (!fromHost) {
    throw new Error("Stella device identity is unavailable.");
  }

  cachedDeviceId = fromHost;
  writeLocalDeviceId(fromHost);
  return fromHost;
};
