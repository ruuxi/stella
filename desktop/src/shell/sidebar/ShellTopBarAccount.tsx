import { useNavigate } from "@tanstack/react-router";
import { router } from "@/router";
import { openEngineDisplayTab } from "@/shell/display/default-tabs";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CreditCard,
  LogOut,
  MessageSquare,
  Palette,
  Settings as SettingsIcon,
} from "lucide-react";
import { useT } from "@/shared/i18n";
import {
  preloadAuthDialog,
  preloadBillingScreen,
  preloadConnectDialog,
  preloadSidebarRoute,
} from "@/shared/lib/sidebar-preloads";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { SUBSCRIPTION_UPGRADED_EVENT } from "@/global/billing/SubscriptionUpgradeDialog";
import { api } from "@/convex/api";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { CustomDevice as Device, CustomLogIn as LogIn } from "./SidebarIcons";
import { useFeedbackPrompt } from "./use-feedback-prompt";
import "./account-dialogs.css";

const FeedbackDialog = lazy(() =>
  import("./FeedbackDialog").then((m) => ({ default: m.FeedbackDialog })),
);

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
  onConnect?: () => void;
}

export const ShellTopBarAccount = ({
  onSignIn,
  onConnect,
}: ShellTopBarAccountProps) => {
  const t = useT();
  const navigate = useNavigate();
  const { user: convexUser, hasConnectedAccount } = useCurrentUser();
  const { user: sessionUser } = useAuthSessionState();
  const { nickname } = useNickname();
  const user = {
    email: convexUser?.email ?? sessionUser?.email ?? undefined,
    name: convexUser?.name ?? sessionUser?.name ?? undefined,
    isAnonymous:
      convexUser?.isAnonymous ?? sessionUser?.isAnonymous ?? undefined,
  };

  const connectHint = usePostOnboardingHint("connect");
  const handleOpenConnect = useCallback(() => {
    preloadConnectDialog();
    if (connectHint.active) connectHint.dismiss();
    onConnect?.();
  }, [connectHint, onConnect]);

  const handleOpenSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  const handleUpgrade = useCallback(() => {
    void navigate({ to: "/billing" });
  }, [navigate]);

  const {
    shouldPrompt: shouldAutoPromptFeedback,
    acknowledge: acknowledgeFeedbackPrompt,
  } = useFeedbackPrompt();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackVariant, setFeedbackVariant] = useState<"manual" | "auto">(
    "manual",
  );

  useEffect(() => {
    if (!shouldAutoPromptFeedback) return;
    if (feedbackOpen) return;
    setFeedbackVariant("auto");
    setFeedbackOpen(true);
    acknowledgeFeedbackPrompt();
  }, [shouldAutoPromptFeedback, feedbackOpen, acknowledgeFeedbackPrompt]);

  const handleOpenFeedback = useCallback(() => {
    setFeedbackVariant("manual");
    setFeedbackOpen(true);
  }, []);

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

  const billingStatus = useConvexOneShot(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount && billingQueryReady ? {} : "skip",
    billingRefreshKey,
  ) as BillingStatusLite | undefined;

  useEffect(() => {
    const handler = () => {
      void router.navigate({ to: "/chat" });
      openEngineDisplayTab();
    };
    window.addEventListener("stella:open-model-picker", handler);
    return () => {
      window.removeEventListener("stella:open-model-picker", handler);
    };
  }, []);

  const pendingFeedbackRef = useRef(false);
  const pendingConnectRef = useRef(false);
  const pendingSettingsRef = useRef(false);
  const pendingThemeRef = useRef(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const pendingSignOutRef = useRef(false);

  const handleDropdownCloseAutoFocus = useCallback(
    (event: Event) => {
      if (pendingFeedbackRef.current) {
        pendingFeedbackRef.current = false;
        event.preventDefault();
        handleOpenFeedback();
        return;
      }
      if (pendingSettingsRef.current) {
        pendingSettingsRef.current = false;
        event.preventDefault();
        handleOpenSettings();
        return;
      }
      if (pendingConnectRef.current) {
        pendingConnectRef.current = false;
        event.preventDefault();
        handleOpenConnect();
        return;
      }
      if (pendingThemeRef.current) {
        pendingThemeRef.current = false;
        event.preventDefault();
        setThemePickerOpen(true);
        return;
      }
      if (pendingSignOutRef.current) {
        pendingSignOutRef.current = false;
        event.preventDefault();
        setSignOutConfirmOpen(true);
      }
    },
    [handleOpenFeedback, handleOpenSettings, handleOpenConnect],
  );

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="shell-topbar-account-settings"
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="bottom"
            align="end"
            sideOffset={8}
            onCloseAutoFocus={handleDropdownCloseAutoFocus}
          >
            <DropdownMenuItem
              onClick={() => {
                pendingSettingsRef.current = true;
              }}
              onMouseEnter={() => preloadSidebarRoute("settings")}
              onFocus={() => preloadSidebarRoute("settings")}
            >
              <span data-slot="dropdown-menu-item-icon">
                <SettingsIcon size={14} strokeWidth={1.75} />
              </span>
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                pendingThemeRef.current = true;
              }}
            >
              <span data-slot="dropdown-menu-item-icon">
                <Palette size={14} strokeWidth={1.75} />
              </span>
              Theme
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                pendingConnectRef.current = true;
              }}
              onMouseEnter={preloadConnectDialog}
              onFocus={preloadConnectDialog}
            >
              <span data-slot="dropdown-menu-item-icon">
                <Device size={14} />
              </span>
              Connect
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                pendingFeedbackRef.current = true;
              }}
            >
              <span data-slot="dropdown-menu-item-icon">
                <MessageSquare size={14} strokeWidth={1.75} />
              </span>
              {t("sidebar.feedback")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ThemePicker
          open={themePickerOpen}
          onOpenChange={setThemePickerOpen}
          hideTrigger
          side="bottom"
          align="end"
          trigger={
            <button
              type="button"
              className="shell-topbar-account-theme-anchor"
              aria-hidden="true"
              tabIndex={-1}
            />
          }
        />
        {feedbackOpen ? (
          <Suspense fallback={null}>
            <FeedbackDialog
              open
              onOpenChange={setFeedbackOpen}
              variant={feedbackVariant}
              onSubmitted={acknowledgeFeedbackPrompt}
            />
          </Suspense>
        ) : null}
      </div>
    );
  }

  const accountName =
    (user.name ?? user.email ?? t("sidebar.account")).trim() ||
    t("sidebar.account");
  const displayLabel = nickname.trim() || accountName;
  const plan = billingStatus?.plan;
  const isPaidPlan = Boolean(plan) && plan !== "free";
  const pillLabel = isPaidPlan
    ? planLabel(plan, billingStatus)
    : t("sidebar.upgrade");

  return (
    <div className="shell-topbar-account">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shell-topbar-account-trigger"
            title={
              displayLabel === accountName
                ? accountName
                : `${displayLabel} · ${accountName}`
            }
            aria-label={accountName}
          >
            <SettingsIcon size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="shell-topbar-account-nickname">
              {displayLabel}
            </span>
            {connectHint.active ? (
              <span
                className="shell-topbar-nav-hint-dot"
                aria-hidden="true"
                style={{ top: 4, right: 4 }}
              />
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
            onClick={() => {
              pendingSettingsRef.current = true;
            }}
            onMouseEnter={() => preloadSidebarRoute("settings")}
            onFocus={() => preloadSidebarRoute("settings")}
          >
            <span data-slot="dropdown-menu-item-icon">
              <SettingsIcon size={14} strokeWidth={1.75} />
            </span>
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              pendingThemeRef.current = true;
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <Palette size={14} strokeWidth={1.75} />
            </span>
            Theme
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              pendingConnectRef.current = true;
            }}
            onMouseEnter={preloadConnectDialog}
            onFocus={preloadConnectDialog}
          >
            <span data-slot="dropdown-menu-item-icon">
              <Device size={14} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>Connect</span>
            {connectHint.active ? (
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--danger, #ef4444)",
                }}
              />
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              preloadBillingScreen();
              handleUpgrade();
            }}
            onMouseEnter={preloadBillingScreen}
            onFocus={preloadBillingScreen}
            title={
              isPaidPlan
                ? `${pillLabel} plan — manage billing`
                : "Upgrade your plan"
            }
          >
            <span data-slot="dropdown-menu-item-icon">
              <CreditCard size={14} strokeWidth={1.75} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              {isPaidPlan ? `${pillLabel} plan` : t("sidebar.upgrade")}
            </span>
            {isPaidPlan ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: "var(--text-weak)",
                  letterSpacing: "0.02em",
                }}
              >
                Manage
              </span>
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              pendingFeedbackRef.current = true;
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <MessageSquare size={14} strokeWidth={1.75} />
            </span>
            {t("sidebar.feedback")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
      <ThemePicker
        open={themePickerOpen}
        onOpenChange={setThemePickerOpen}
        hideTrigger
        side="bottom"
        align="end"
        trigger={
          <button
            type="button"
            className="shell-topbar-account-theme-anchor"
            aria-hidden="true"
            tabIndex={-1}
          />
        }
      />
      {feedbackOpen ? (
        <Suspense fallback={null}>
          <FeedbackDialog
            open
            onOpenChange={setFeedbackOpen}
            variant={feedbackVariant}
            onSubmitted={acknowledgeFeedbackPrompt}
          />
        </Suspense>
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
