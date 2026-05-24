import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { router } from "@/router";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { SUBSCRIPTION_UPGRADED_EVENT } from "@/global/billing/SubscriptionUpgradeDialog";
import {
  ArrowLeft,
  CreditCard,
  LogOut,
  MessageSquare,
  Palette,
  Settings as SettingsIcon,
} from "lucide-react";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { useT } from "@/shared/i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppMetadata } from "@/app/_shared/app-metadata";
import {
  getSnapshot as getAppRegistrySnapshot,
  subscribe as subscribeToAppRegistry,
} from "./app-registry";
import { useSocialBadges } from "@/app/social/hooks/use-social-badges";
import { api } from "@/convex/api";
import {
  dismissPostOnboardingHint,
  usePostOnboardingHint,
} from "@/global/onboarding/post-onboarding-hints";
import {
  preloadAuthDialog,
  preloadBillingScreen,
  preloadConnectDialog,
  preloadSidebarRoute,
} from "@/shared/lib/sidebar-preloads";
import {
  useDefaultPageSidebarBack,
  usePageSidebarOverride,
} from "@/context/page-sidebar";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
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
import {
  CustomDevice as Device,
  CustomLogIn as LogIn,
} from "./SidebarIcons";
import { useFeedbackPrompt } from "./use-feedback-prompt";
import "./sidebar.css";

const FeedbackDialog = lazy(() =>
  import("./FeedbackDialog").then((m) => ({
    default: m.FeedbackDialog,
  })),
);

// App discovery happens in `./app-registry`, which owns the glob over
// `desktop/src/app/<id>/metadata.ts` and exposes a subscribable snapshot.
// The registry self-accepts HMR updates so adding a new `metadata.ts`
// doesn't propagate invalidation up through Sidebar to `__root.tsx` and
// force a full renderer reload -- the snapshot updates in place and the
// subscription below re-renders just the list.
//
// Add a new app by dropping a `metadata.ts` into `desktop/src/app/<id>/`.
// No edits to this file are needed.
const useRegisteredApps = (): readonly AppMetadata[] =>
  useSyncExternalStore(subscribeToAppRegistry, getAppRegistrySnapshot);

interface SidebarProps {
  className?: string;
  visible?: boolean;
  onHide?: () => void;
  onSignIn?: () => void;
  onConnect?: () => void;
}

interface AppNavItemProps {
  app: AppMetadata;
  badgeCount?: number;
  /** Show a small one-time "look here" red dot until the user visits
   *  this app. Suppressed automatically when `badgeCount > 0` so a
   *  Social-style unread count always wins over a hint nudge. */
  showHintDot?: boolean;
  /** Called when the user clicks the item while the hint dot is shown
   *  so the parent can dismiss the hint. Fires before navigation. */
  onHintDismiss?: () => void;
}

const AppNavItem = ({
  app,
  badgeCount = 0,
  showHintDot = false,
  onHintDismiss,
}: AppNavItemProps) => {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(matchRoute({ to: app.route }));
  const showActive = isActive && !app.suppressActiveState;
  const Icon = app.icon;

  const showBadge = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);
  const showHint = showHintDot && !showBadge;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      preloadSidebarRoute(app.id);
      if (showHint) onHintDismiss?.();
      if (isActive && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
      }
    },
    [isActive, app, showHint, onHintDismiss],
  );

  return (
    <Link
      to={app.route}
      className={`sidebar-nav-item${showActive ? " sidebar-nav-item--active" : ""}`}
      onClick={handleClick}
      onFocus={() => preloadSidebarRoute(app.id)}
      onMouseEnter={() => preloadSidebarRoute(app.id)}
      title={
        showBadge ? `${app.label} (${badgeCount} unread)` : app.label
      }
      aria-label={
        showBadge ? `${app.label}, ${badgeCount} unread` : app.label
      }
    >
      <span className="sidebar-nav-icon">
        <Icon size={20} />
        {showBadge && (
          <span className="sidebar-nav-badge" aria-hidden="true">
            {badgeLabel}
          </span>
        )}
        {showHint && (
          <span className="sidebar-nav-hint-dot" aria-hidden="true" />
        )}
      </span>
      <span className="sidebar-nav-label">{app.label}</span>
    </Link>
  );
};

// ---------------------------------------------------------------------------
// Account section: avatar + Upgrade / plan pill
// ---------------------------------------------------------------------------

type BillingPlanId = "free" | "go" | "pro" | "plus" | "ultra";

type BillingStatusLite = {
  plan?: BillingPlanId;
  plans?: Partial<Record<BillingPlanId, { label?: string }>>;
};

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

// Hash an identity string into one of a handful of pleasant avatar
// background tints so different users get visibly different chips
// without us picking the colors per user.
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

interface AccountRowProps {
  onSignIn?: () => void;
  onUpgrade: () => void;
  onOpenFeedback: () => void;
  onOpenSettings: () => void;
  onOpenConnect: () => void;
  showConnectHint: boolean;
}

const AccountRow = ({
  onSignIn,
  onUpgrade,
  onOpenFeedback,
  onOpenSettings,
  onOpenConnect,
  showConnectHint,
}: AccountRowProps) => {
  const t = useT();
  const { user: convexUser, hasConnectedAccount } = useCurrentUser();
  const { user: sessionUser } = useAuthSessionState();
  const user = {
    email: convexUser?.email ?? sessionUser?.email ?? undefined,
    name: convexUser?.name ?? sessionUser?.name ?? undefined,
    isAnonymous: convexUser?.isAnonymous ?? sessionUser?.isAnonymous ?? undefined,
  };
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

  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const pendingSignOutRef = useRef(false);
  const pendingFeedbackRef = useRef(false);
  const pendingConnectRef = useRef(false);
  const pendingSettingsRef = useRef(false);
  const pendingThemeRef = useRef(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

  useEffect(() => {
    const handler = () => {
      void router.navigate({ to: "/settings", search: { tab: "models" } });
    };
    window.addEventListener("stella:open-model-picker", handler);
    return () => {
      window.removeEventListener("stella:open-model-picker", handler);
    };
  }, []);

  const handleDropdownCloseAutoFocus = useCallback(
    (event: Event) => {
      if (pendingSignOutRef.current) {
        pendingSignOutRef.current = false;
        event.preventDefault();
        setSignOutConfirmOpen(true);
        return;
      }
      if (pendingFeedbackRef.current) {
        pendingFeedbackRef.current = false;
        event.preventDefault();
        onOpenFeedback();
        return;
      }
      if (pendingSettingsRef.current) {
        pendingSettingsRef.current = false;
        event.preventDefault();
        onOpenSettings();
        return;
      }
      if (pendingConnectRef.current) {
        pendingConnectRef.current = false;
        event.preventDefault();
        onOpenConnect();
        return;
      }
      if (pendingThemeRef.current) {
        pendingThemeRef.current = false;
        event.preventDefault();
        setThemePickerOpen(true);
      }
    },
    [onOpenFeedback, onOpenSettings, onOpenConnect],
  );

  const handleConfirmSignOut = useCallback(() => {
    setSignOutConfirmOpen(false);
    void secureSignOut();
  }, []);

  const themePicker = (
    <ThemePicker
      open={themePickerOpen}
      onOpenChange={setThemePickerOpen}
      hideTrigger
      side="top"
      align="start"
      trigger={
        <button
          type="button"
          className="sidebar-account-theme-anchor"
          aria-hidden="true"
          tabIndex={-1}
        />
      }
    />
  );

  const plan = billingStatus?.plan;
  const isPaidPlan = Boolean(plan) && plan !== "free";
  const pillLabel = isPaidPlan
    ? planLabel(plan, billingStatus)
    : t("sidebar.upgrade");

  const accountMenuItems = (
    includeAccountActions: boolean,
  ) => (
    <>
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
        {showConnectHint ? (
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
      {includeAccountActions ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              preloadBillingScreen();
              onUpgrade();
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
        </>
      ) : null}
    </>
  );

  if (!hasConnectedAccount) {
    return (
      <div className="sidebar-account sidebar-account--signed-out">
        <button
          type="button"
          className="sidebar-account-signin"
          onClick={() => {
            preloadAuthDialog();
            onSignIn?.();
          }}
          onFocus={preloadAuthDialog}
          onMouseEnter={preloadAuthDialog}
          title={t("sidebar.signIn")}
          aria-label={t("sidebar.signIn")}
        >
          <span className="sidebar-account-signin-icon">
            <LogIn size={20} />
          </span>
          <span className="sidebar-account-signin-label">
            {t("sidebar.signIn")}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="sidebar-account-menu-trigger"
              title="Menu"
              aria-label="Menu"
            >
              <SettingsIcon size={18} strokeWidth={1.75} />
              {showConnectHint ? (
                <span className="sidebar-nav-hint-dot" aria-hidden="true" />
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="end"
            sideOffset={8}
            onCloseAutoFocus={handleDropdownCloseAutoFocus}
          >
            {accountMenuItems(false)}
          </DropdownMenuContent>
        </DropdownMenu>
        {themePicker}
      </div>
    );
  }

  const initials = initialsFromIdentity(user.email, user.name);
  const swatch = avatarSwatchFromIdentity(user.email ?? user.name);
  const accountLabel =
    (user.name ?? user.email ?? t("sidebar.account")).trim() ||
    t("sidebar.account");

  return (
    <div className="sidebar-account">
      <div className="sidebar-account-menu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="sidebar-account-trigger"
              title={user.email ?? user.name ?? t("sidebar.account")}
              aria-label={accountLabel}
            >
              <span
                className="sidebar-account-avatar"
                aria-hidden="true"
                style={{
                  background: swatch.background,
                  color: swatch.color,
                  borderColor: swatch.border,
                }}
              >
                {initials}
              </span>
              <span className="sidebar-account-label">{accountLabel}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={8}
            onCloseAutoFocus={handleDropdownCloseAutoFocus}
          >
            {accountMenuItems(true)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
      {themePicker}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const TitleBarSpacer = () => <div className="sidebar-titlebar" />;

export const Sidebar = ({
  className,
  visible = true,
  onHide,
  onSignIn,
  onConnect,
}: SidebarProps) => {
  const navigate = useNavigate();
  const pageOverride = usePageSidebarOverride();
  const defaultBack = useDefaultPageSidebarBack();

  const allApps = useRegisteredApps();
  const navApps = useMemo(
    () => allApps.filter((a) => !a.hideFromSidebar && a.slot === "top"),
    [allApps],
  );

  useEffect(() => {
    window.electronAPI?.window.setNativeButtonsVisible?.(true);
  }, []);

  const handleBrandClick = useCallback(() => {
    onHide?.();
  }, [onHide]);

  const handleUpgrade = useCallback(() => {
    void navigate({ to: "/billing" });
  }, [navigate]);

  const connectHint = usePostOnboardingHint("connect");
  const handleOpenConnect = useCallback(() => {
    preloadConnectDialog();
    if (connectHint.active) connectHint.dismiss();
    onConnect?.();
  }, [connectHint, onConnect]);

  const handleOpenSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  const { shouldPrompt: shouldAutoPromptFeedback, acknowledge: acknowledgeFeedbackPrompt } =
    useFeedbackPrompt();
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

  const { totalBadge: socialBadge } = useSocialBadges();
  const badgeCountForApp = useCallback(
    (app: AppMetadata) => (app.id === "social" ? socialBadge : 0),
    [socialBadge],
  );

  const storeHint = usePostOnboardingHint("store");
  const matchRoute = useMatchRoute();
  const onStoreRoute = Boolean(matchRoute({ to: "/store", fuzzy: true }));
  useEffect(() => {
    if (storeHint.active && onStoreRoute) {
      dismissPostOnboardingHint("store");
    }
  }, [onStoreRoute, storeHint.active]);
  const showHintForApp = useCallback(
    (app: AppMetadata) => app.id === "store" && storeHint.active,
    [storeHint.active],
  );
  const dismissHintForApp = useCallback(
    (app: AppMetadata) => {
      if (app.id === "store") dismissPostOnboardingHint("store");
    },
    [],
  );

  const sidebarClass = useMemo(() => {
    const parts = ["sidebar"];
    if (className) parts.push(className);
    if (!visible) parts.push("sidebar--hidden");
    return parts.join(" ");
  }, [className, visible]);

  return (
    <aside className={sidebarClass}>
      <div className="sidebar-stack">
        <TitleBarSpacer />
        <button
          type="button"
          className="sidebar-brand"
          onClick={handleBrandClick}
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <span className="sidebar-brand-logo" aria-hidden="true">
            <img src="stella-logo.svg" alt="" className="sidebar-brand-logo-art" />
          </span>
          <span className="sidebar-brand-text">Stella</span>
        </button>
        {pageOverride ? (
          <nav className="sidebar-nav sidebar-nav--page-override">
            <button
              type="button"
              className="sidebar-page-back"
              onClick={defaultBack}
              title="Back"
              aria-label="Back"
            >
              <span className="sidebar-nav-icon">
                <ArrowLeft size={20} />
              </span>
              <span className="sidebar-nav-label">
                {pageOverride.title ?? "Back"}
              </span>
            </button>
            <div className="sidebar-page-override-content">
              {pageOverride.content}
            </div>
          </nav>
        ) : (
          <>
            <nav className="sidebar-nav">
              {navApps.map((app) => (
                <AppNavItem
                  key={app.id}
                  app={app}
                  badgeCount={badgeCountForApp(app)}
                  showHintDot={showHintForApp(app)}
                  onHintDismiss={() => dismissHintForApp(app)}
                />
              ))}
            </nav>
            <div className="sidebar-footer">
              <AccountRow
                onSignIn={onSignIn}
                onUpgrade={handleUpgrade}
                onOpenFeedback={handleOpenFeedback}
                onOpenSettings={handleOpenSettings}
                onOpenConnect={handleOpenConnect}
                showConnectHint={connectHint.active}
              />
            </div>
          </>
        )}
      </div>
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
    </aside>
  );
};
