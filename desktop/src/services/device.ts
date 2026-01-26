const DEVICE_ID_KEY = "stellar.deviceId";

export const getOrCreateDeviceId = () => {
  if (typeof window === "undefined") {
    return "unknown-device";
  }

  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }

  const fallback = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : fallback;
  window.localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
};
