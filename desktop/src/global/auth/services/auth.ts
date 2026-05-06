import { api } from "@/convex/api";
import { convexClient } from "@/infra/convex-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";
import { getDeviceIdOrNull } from "@/platform/electron/device";

type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (scope: SignOutScope = "current_device") => {
  // Resolve the device id and fan both pre-sign-out mutations out in
  // parallel — they're independent (revoke is account-scoped, goOffline
  // is device-scoped) and `Promise.allSettled` keeps either failure
  // best-effort. They must complete before `signOutAuthSession` clears
  // the local auth token, so we await before tearing the session down.
  const deviceId = await getDeviceIdOrNull();
  const tasks: Promise<unknown>[] = [];
  if (scope === "all_devices") {
    tasks.push(
      convexClient.mutation(api.auth.revokeActiveSessions, {}).catch((error) => {
        console.debug(
          "[auth] Session revocation failed (best-effort):",
          (error as Error).message,
        );
      }),
    );
  }
  if (deviceId) {
    tasks.push(
      convexClient.mutation(api.agent.device_resolver.goOffline, {
        deviceId,
      }).catch((error) => {
        console.debug(
          "[auth] goOffline before sign-out failed (best-effort):",
          (error as Error).message,
        );
      }),
    );
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
  await signOutAuthSession();
};
