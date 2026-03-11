import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "./use-auth-session-state";

export type AccountMode = "private_local" | "connected";

export function useAccountMode(): AccountMode | undefined {
  const { hasConnectedAccount } = useAuthSessionState();
  return useQuery(
    api.data.preferences.getAccountMode,
    hasConnectedAccount ? {} : "skip",
  ) as AccountMode | undefined;
}

