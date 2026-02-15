import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { secureSignOut } from "@/services/auth";

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
        onClick={() => {
          void secureSignOut();
        }}
      >
        Sign out
      </button>
    </div>
  );
};
