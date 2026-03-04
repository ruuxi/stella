import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/api";

export type AccountMode = "private_local" | "connected";

export function useAccountMode(): AccountMode | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(
    api.data.preferences.getAccountMode,
    isAuthenticated ? {} : "skip",
  ) as AccountMode | undefined;
}

