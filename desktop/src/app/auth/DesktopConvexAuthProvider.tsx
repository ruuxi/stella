import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { ConvexProviderWithAuth } from "convex/react";
import { authClient } from "@/app/auth/lib/auth-client";
import { getConvexToken } from "@/app/auth/services/auth-token";
import { convexClient } from "@/infra/convex-client";

function useDesktopConvexAuth() {
  const session = authClient.useSession();

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken = false }: { forceRefreshToken?: boolean } = {}) => {
      return await getConvexToken({ forceRefresh: forceRefreshToken });
    },
    [],
  );

  return useMemo(
    () => ({
      isLoading: Boolean(session.isPending),
      isAuthenticated: Boolean(session.data),
      fetchAccessToken,
    }),
    [fetchAccessToken, session.data, session.isPending],
  );
}

export function DesktopConvexAuthProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convexClient} useAuth={useDesktopConvexAuth}>
      {children}
    </ConvexProviderWithAuth>
  );
}
