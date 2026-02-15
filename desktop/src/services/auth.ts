import { authClient } from "@/lib/auth-client";
import { api } from "@/convex/api";
import { convexClient } from "./convex-client";

export const secureSignOut = async () => {
  try {
    await convexClient.mutation(api.auth.revokeActiveSessions, {});
  } catch (error) {
    console.warn("[auth] Failed to revoke active sessions before sign-out", error);
  }
  await authClient.signOut();
};
