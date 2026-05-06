import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { useAuthSessionState } from "./use-auth-session-state";

type CurrentUser = {
  email?: string;
  name?: string;
  isAnonymous?: boolean;
} | null | undefined;

// Identity (email/name/anonymous) doesn't move while the app is
// running — it changes on sign-in/out, and `hasConnectedAccount` already
// flips when that happens. One-shot fetch instead of a persistent
// subscription so the always-mounted Sidebar isn't holding a Convex
// watcher open for static data.
export function useCurrentUser(): { user: CurrentUser; hasConnectedAccount: boolean } {
  const { hasConnectedAccount } = useAuthSessionState();
  const user = useConvexOneShot(
    api.auth.getCurrentUser,
    hasConnectedAccount ? {} : "skip",
  ) as CurrentUser;
  return { user, hasConnectedAccount };
}
