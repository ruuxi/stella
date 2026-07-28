import { useCallback, useEffect, useRef, useState } from "react";
import { LogOut, Settings as SettingsIcon } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import {
  preloadAuthDialog,
  preloadNavSurfaceRoute,
} from "@/shell/topbar/nav-surface-preloads";
import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { SUBSCRIPTION_UPGRADED_EVENT } from "@/global/billing/SubscriptionUpgradeDialog";
import { api } from "@/convex/api";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { useNickname } from "@/global/auth/hooks/use-nickname";
import { secureSignOut } from "@/global/auth/services/auth";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
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
import { CustomLogIn as LogIn } from "@/ui/nav-icons";
import { useFeedbackPrompt } from "./use-feedback-prompt";
import "./topbar-nav.css";
import "./account-dialogs.css";

type BillingPlanId = "free" | "go" | "pro" | "plus" | "ultra";

type BillingStatusLite = {
  plan?: BillingPlanId;
  plans?: Partial<Record<BillingPlanId, { label?: string }>>;
};

const planLabel = (
  plan: BillingPlanId | undefined,
  status: BillingStatusLite | undefined,
): string => {
  if (!plan) return "Free";
  const live = status?.plans?.[plan]?.label;
  if (live) return live;
  switch (plan) {
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "pro":
      return "Pro";
    case "plus":
      return "Plus";
    case "ultra":
      return "Ultra";
  }
};

interface ShellTopBarAccountProps {
  onSignIn?: () => void;
}

export const ShellTopBarAccount = ({
  onSignIn,
}: ShellTopBarAccountProps) => {
  const t = useT();
  const { user: convexUser, hasConnectedAccount } = useCurrentUser();
  const { cacheScope, user: sessionUser } = useAuthSessionState();
  const { nickname } = useNickname();
  const panelOpen = useDisplayPanelOpen();
  const user = {
    email: convexUser?.email ?? sessionUser?.email ?? undefined,
    name: convexUser?.name ?? sessionUser?.name ?? undefined,
  };

  const connectHint = usePostOnboardingHint("connect");
  const handleOpenSettings = useCallback(() => {
    preloadNavSurfaceRoute("settings");
    sidebarSections.openLocation("settings", null);
  }, []);

  const {
    shouldPrompt: shouldAutoPromptFeedback,
    acknowledge: acknowledgeFeedbackPrompt,
  } = useFeedbackPrompt();

  useEffect(() => {
    if (!shouldAutoPromptFeedback) return;
    sidebarSections.openLocation("settings", "feedback");
    acknowledgeFeedbackPrompt();
  }, [shouldAutoPromptFeedback, acknowledgeFeedbackPrompt]);

  const [billingQueryReady, setBillingQueryReady] = useState(false);
  useEffect(() => {
    const scheduleIdle =
      window.requestIdleCallback ??
      ((callback: IdleRequestCallback) =>
        window.setTimeout(
          () =>
            callback({
              didTimeout: false,
              timeRemaining: () => 0,
            } as IdleDeadline),
          1,
        ));
    const cancelIdle =
      window.cancelIdleCallback ??
      ((handle: number) => window.clearTimeout(handle));
    const handle = scheduleIdle(() => setBillingQueryReady(true));
    return () => cancelIdle(handle);
  }, []);

  const [billingRefreshKey, setBillingRefreshKey] = useState(0);
  useEffect(() => {
    const handler = () => setBillingRefreshKey((n) => n + 1);
    window.addEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
    return () =>
      window.removeEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
  }, []);

  const billingStatus = usePersistentConvexOneShot(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount && billingQueryReady ? {} : "skip",
    {
      scope: cacheScope,
      ttlMs: 5 * 60 * 1000,
      refreshKey: billingRefreshKey,
    },
  ) as BillingStatusLite | undefined;

  const pendingSignOutRef = useRef(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);

  const handleDropdownCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    if (!pendingSignOutRef.current) return;
    pendingSignOutRef.current = false;
    setSignOutConfirmOpen(true);
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
        {!panelOpen ? (
          <button
            type="button"
            className="shell-topbar-account-settings"
            onClick={handleOpenSettings}
            onFocus={() => preloadNavSurfaceRoute("settings")}
            onMouseEnter={() => preloadNavSurfaceRoute("settings")}
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  }

  const accountName =
    (user.name ?? user.email ?? t("sidebar.account")).trim() ||
    t("sidebar.account");
  const displayLabel = nickname.trim() || accountName;
  const sidebarPlanLabel = billingQueryReady
    ? planLabel(billingStatus?.plan, billingStatus)
    : null;

  return (
    <div className="shell-topbar-account">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shell-topbar-account-trigger"
            title={
              displayLabel === accountName
                ? sidebarPlanLabel
                  ? `${accountName} · ${sidebarPlanLabel}`
                  : accountName
                : sidebarPlanLabel
                  ? `${displayLabel} · ${accountName} · ${sidebarPlanLabel}`
                  : `${displayLabel} · ${accountName}`
            }
            aria-label={
              sidebarPlanLabel
                ? `${displayLabel}, ${sidebarPlanLabel} plan`
                : displayLabel
            }
          >
            <span className="shell-topbar-account-identity">
              <span className="shell-topbar-account-nickname">
                {displayLabel}
              </span>
              {sidebarPlanLabel ? (
                <span className="shell-topbar-account-plan">
                  {sidebarPlanLabel}
                </span>
              ) : null}
            </span>
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
      {!panelOpen ? (
        <button
          type="button"
          className="shell-topbar-account-settings"
          onClick={handleOpenSettings}
          onFocus={() => preloadNavSurfaceRoute("settings")}
          onMouseEnter={() => preloadNavSurfaceRoute("settings")}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon size={14} strokeWidth={1.75} aria-hidden="true" />
          {connectHint.active ? (
            <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
          ) : null}
        </button>
      ) : null}
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
