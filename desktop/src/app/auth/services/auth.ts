import { authClient } from "@/app/auth/lib/auth-client";
import { api } from "@/convex/api";
import { convexClient } from "@/infra/convex-client";

export type SignOutScope = "current_device" | "all_devices";

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
  await authClient.signOut();
};

export const secureSignOutAllDevices = async () => {
  await secureSignOut("all_devices");
};
