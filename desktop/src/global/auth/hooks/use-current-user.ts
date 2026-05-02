import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "./use-auth-session-state";

type CurrentUser = {
  email?: string;
  name?: string;
  isAnonymous?: boolean;
} | null | undefined;

export function useCurrentUser(): { user: CurrentUser; hasConnectedAccount: boolean } {
  const { hasConnectedAccount } = useAuthSessionState();
  const user = useQuery(
    api.auth.getCurrentUser,
    hasConnectedAccount ? {} : "skip",
  ) as CurrentUser;
  return { user, hasConnectedAccount };
}
