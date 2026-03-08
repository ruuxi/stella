import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/api";

export type CurrentUser = {
  email?: string;
  name?: string;
  isAnonymous?: boolean;
} | null | undefined;

export function useCurrentUser(): { user: CurrentUser; isAuthenticated: boolean } {
  const { isAuthenticated } = useConvexAuth();
  const user = useQuery(
    api.auth.getCurrentUser,
    isAuthenticated ? {} : "skip",
  ) as CurrentUser;
  return { user, isAuthenticated };
}

