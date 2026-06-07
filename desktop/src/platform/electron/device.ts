import { getElectronApi } from "./electron";
import { writeLocalDeviceId } from "./device-id";
import {
  readConfiguredConvexSiteUrl,
  readConfiguredConvexUrl,
} from "@/shared/lib/convex-urls";

export { getDeviceIdOrNull, getOrCreateDeviceId } from "./device-id";

// The runtime config (Convex URLs) comes from `import.meta.env` and never
// changes within a session, yet `configurePiRuntime` is invoked 3-5+ times
// serially during cold start. Cache the resolved promise on FIRST SUCCESS only
// so it runs at most once per session. On failure we leave the cache empty so a
// later call can retry (and still run `writeLocalDeviceId`). Identity is
// unaffected — `getOrCreateDeviceId` seeds the device id independently.
let configurePiRuntimePromise: Promise<void> | null = null;

const runConfigurePiRuntime = async () => {
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
  const response = await api.system.configurePiRuntime({
    convexUrl,
    convexSiteUrl,
  });
  if (response?.deviceId) {
    writeLocalDeviceId(response.deviceId);
  }
};

export const configurePiRuntime = async () => {
  if (configurePiRuntimePromise) {
    return configurePiRuntimePromise;
  }
  const attempt = runConfigurePiRuntime();
  // Cache only on success; on failure clear so the next call can retry.
  configurePiRuntimePromise = attempt.then(
    () => undefined,
    (err) => {
      configurePiRuntimePromise = null;
      console.debug(
        "[device] configurePiRuntime failed:",
        (err as Error).message,
      );
    },
  );
  return configurePiRuntimePromise;
};
