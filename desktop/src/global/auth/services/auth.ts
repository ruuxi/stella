import { api } from "@/convex/api";
import { convexClient } from "@/infra/convex-client";
import { signOutAuthSession } from "@/global/auth/services/auth-session";

type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (
  scope: SignOutScope = "current_device",
) => {
  if (scope === "all_devices") {
    try {
      await convexClient.mutation(api.auth.revokeActiveSessions, {});
    } catch (error) {
      console.debug('[auth] Session revocation failed (best-effort):', (error as Error).message);
    }
  }
  const deviceId = await window.electronAPI?.system.getDeviceId?.();
  if (deviceId) {
    try {
      await convexClient.mutation(api.agent.device_resolver.goOffline, {
        deviceId,
      });
    } catch (error) {
      console.debug(
        "[auth] goOffline before sign-out failed (best-effort):",
        (error as Error).message,
      );
    }
  }
  await signOutAuthSession();
};
