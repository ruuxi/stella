import { authClient } from "@/lib/auth-client";
import { api } from "@/convex/api";
import { convexClient } from "./convex-client";

export type SignOutScope = "current_device" | "all_devices";

export const secureSignOut = async (
  scope: SignOutScope = "current_device",
) => {
  if (scope === "all_devices") {
    try {
      await convexClient.mutation(api.auth.revokeActiveSessions, {});
    } catch (error) {
      console.warn("[auth] Failed to revoke active sessions before sign-out", error);
    }
  }
  await authClient.signOut();
};

export const secureSignOutAllDevices = async () => {
  await secureSignOut("all_devices");
};
