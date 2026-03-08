import { useCurrentUser } from "@/app/auth/hooks/use-current-user";
import { secureSignOut } from "@/app/auth/services/auth";

export const AuthStatus = () => {
  const { user, isAuthenticated } = useCurrentUser();

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
