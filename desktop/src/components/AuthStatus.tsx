import { useConvexAuth, useQuery } from "convex/react";
import { authClient } from "@/lib/auth-client";
import { api } from "@/convex/api";

export const AuthStatus = () => {
  const { isAuthenticated } = useConvexAuth();
  const user = useQuery(api.auth.getCurrentUser, isAuthenticated ? {} : "skip") as
    | { email?: string; name?: string }
    | null
    | undefined;

  if (!isAuthenticated) {
    return null;
  }

  const label = user?.name ?? user?.email ?? "Signed in";

  return (
    <div className="auth-status">
      <span className="auth-status-label">{label}</span>
      <button
        className="auth-status-button"
        type="button"
        onClick={() => authClient.signOut()}
      >
        Sign out
      </button>
    </div>
  );
};
