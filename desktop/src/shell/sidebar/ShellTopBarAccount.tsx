import { useCallback, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { useT } from "@/shared/i18n";
import { preloadAuthDialog } from "@/shared/lib/sidebar-preloads";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { useNickname } from "@/global/auth/hooks/use-nickname";
import { secureSignOut } from "@/global/auth/services/auth";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { CustomLogIn as LogIn } from "./SidebarIcons";
import "./account-dialogs.css";

const initialsFromIdentity = (
  email: string | null | undefined,
  name: string | null | undefined,
): string => {
  const trimmedName = (name ?? "").trim();
  if (trimmedName) {
    const parts = trimmedName.split(/\s+/).slice(0, 2);
    const fromName = parts.map((p) => p.charAt(0)).join("");
    if (fromName) return fromName.slice(0, 2).toUpperCase();
  }
  const local = (email ?? "").split("@")[0] ?? "";
  return local.slice(0, 2).toUpperCase() || "?";
};

const AVATAR_HUES = [
  210, 250, 285, 320, 350, 18, 38, 70, 140, 170, 195,
] as const;

const avatarSwatchFromIdentity = (
  identity: string | null | undefined,
): { background: string; color: string; border: string } => {
  const seed = (identity ?? "").trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = AVATAR_HUES[hash % AVATAR_HUES.length] ?? AVATAR_HUES[0];
  return {
    background: `oklch(0.88 0.06 ${hue})`,
    color: `oklch(0.32 0.05 ${hue})`,
    border: `oklch(0.78 0.05 ${hue} / 0.5)`,
  };
};

interface ShellTopBarAccountProps {
  onSignIn?: () => void;
}

export const ShellTopBarAccount = ({ onSignIn }: ShellTopBarAccountProps) => {
  const t = useT();
  const { user: convexUser, hasConnectedAccount } = useCurrentUser();
  const { user: sessionUser } = useAuthSessionState();
  const { nickname } = useNickname();
  const user = {
    email: convexUser?.email ?? sessionUser?.email ?? undefined,
    name: convexUser?.name ?? sessionUser?.name ?? undefined,
    isAnonymous:
      convexUser?.isAnonymous ?? sessionUser?.isAnonymous ?? undefined,
  };

  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const pendingSignOutRef = useRef(false);

  const handleDropdownCloseAutoFocus = useCallback((event: Event) => {
    if (pendingSignOutRef.current) {
      pendingSignOutRef.current = false;
      event.preventDefault();
      setSignOutConfirmOpen(true);
    }
  }, []);

  const handleConfirmSignOut = useCallback(() => {
    setSignOutConfirmOpen(false);
    void secureSignOut();
  }, []);

  if (!hasConnectedAccount) {
    return (
      <div className="shell-topbar-account">
        <button
          type="button"
          className="shell-topbar-account-signin"
          onClick={() => {
            preloadAuthDialog();
            onSignIn?.();
          }}
          onFocus={preloadAuthDialog}
          onMouseEnter={preloadAuthDialog}
          title={t("sidebar.signIn")}
          aria-label={t("sidebar.signIn")}
        >
          <span className="shell-topbar-account-signin-icon">
            <LogIn size={14} />
          </span>
          <span className="shell-topbar-account-signin-label">
            {t("sidebar.signIn")}
          </span>
        </button>
      </div>
    );
  }

  const initials = initialsFromIdentity(user.email, user.name);
  const swatch = avatarSwatchFromIdentity(user.email ?? user.name);
  const accountName =
    (user.name ?? user.email ?? t("sidebar.account")).trim() ||
    t("sidebar.account");
  const displayLabel = nickname.trim();

  return (
    <div className="shell-topbar-account">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shell-topbar-account-trigger"
            title={displayLabel ? `${displayLabel} · ${accountName}` : accountName}
            aria-label={accountName}
          >
            <span
              className="shell-topbar-account-avatar"
              aria-hidden="true"
              style={{
                background: swatch.background,
                color: swatch.color,
                borderColor: swatch.border,
              }}
            >
              {initials}
            </span>
            {displayLabel ? (
              <span className="shell-topbar-account-nickname">
                {displayLabel}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="end"
          sideOffset={8}
          onCloseAutoFocus={handleDropdownCloseAutoFocus}
        >
          <DropdownMenuItem
            data-variant="destructive"
            onClick={() => {
              pendingSignOutRef.current = true;
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <LogOut size={14} strokeWidth={1.75} />
            </span>
            {t("common.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={signOutConfirmOpen} onOpenChange={setSignOutConfirmOpen}>
        <DialogContent
          fit
          className="sidebar-signout-dialog"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>Sign out of Stella?</DialogTitle>
          </DialogHeader>
          <DialogDescription className="sidebar-signout-description">
            Are you sure?
          </DialogDescription>
          <div className="sidebar-confirm-actions">
            <Button
              variant="ghost"
              size="large"
              className="pill-btn pill-btn--lg"
              onClick={() => setSignOutConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={handleConfirmSignOut}
              data-tone="destructive"
              className="pill-btn pill-btn--danger pill-btn--lg"
            >
              Sign out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
