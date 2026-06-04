import { getElectronApi } from "./electron";

const DEVICE_ID_KEY = "Stella.deviceId";

let cachedDeviceId: string | null = null;

export const writeLocalDeviceId = (deviceId: string) => {
  cachedDeviceId = deviceId;
  window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
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

  writeLocalDeviceId(fromHost);
  return fromHost;
};

export const getDeviceIdOrNull = async (): Promise<string | null> => {
  try {
    return await getOrCreateDeviceId();
  } catch {
    return null;
  }
};
