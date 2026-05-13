import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { SUBSCRIPTION_UPGRADED_EVENT } from "@/global/billing/SubscriptionUpgradeDialog";
import {
  ArrowLeft,
  Cpu,
  LogOut,
  MessageSquare,
  Palette,
  Settings as SettingsIcon,
} from "lucide-react";
import { ModelsPicker } from "@/global/settings/ModelsPicker";
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
  type ReactNode,
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
  preloadModelsPicker,
  preloadSettingsScreen,
  preloadSidebarRoute,
} from "@/shared/lib/sidebar-preloads";
import {
  useDefaultPageSidebarBack,
  usePageSidebarOverride,
} from "@/context/page-sidebar";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { secureSignOut } from "@/global/auth/services/auth";
import { STELLA_TOGGLE_SIDEBAR_RAIL_EVENT } from "@/shell/ShellTopBar";
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
  CustomPlusSquare as PlusSquare,
} from "./SidebarIcons";
import { useFeedbackPrompt } from "./use-feedback-prompt";
import "./sidebar.css";

const FeedbackDialog = lazy(() =>
  import("./FeedbackDialog").then((m) => ({
    default: m.FeedbackDialog,
  })),
);

interface SidebarActionsBarProps {
  onConnect?: () => void;
  onOpenSettings: () => void;
}

/**
 * Compact row of icon-only utility buttons rendered just below the
 * account row. Hosts Settings, Models, Theme, and Connect. Used when
 * the sidebar is in its full (non-rail) mode where there's room for
 * the four-button row; rail mode swaps this out for the single-button
 * `SidebarActionsMenu` instead.
 */
const SidebarActionsBar = ({
  onConnect,
  onOpenSettings,
}: SidebarActionsBarProps) => {
  const connectHint = usePostOnboardingHint("connect");
  const handleConnectClick = useCallback(() => {
    if (connectHint.active) connectHint.dismiss();
    onConnect?.();
  }, [connectHint, onConnect]);
  return (
    <div className="sidebar-actions-bar" role="toolbar" aria-label="Quick actions">
      <button
        type="button"
        className="sidebar-actions-btn"
        onClick={() => {
          preloadSettingsScreen();
          onOpenSettings();
        }}
        onFocus={preloadSettingsScreen}
        onMouseEnter={preloadSettingsScreen}
        aria-label="Settings"
        title="Settings"
      >
        <SettingsIcon size={15} strokeWidth={1.75} />
      </button>
      <ModelsPicker
        side="top"
        align="start"
        trigger={
          <button
            type="button"
            className="sidebar-actions-btn"
            aria-label="Models"
            title="Models"
            onFocus={preloadModelsPicker}
            onMouseEnter={preloadModelsPicker}
          >
            <Cpu size={15} strokeWidth={1.75} />
          </button>
        }
      />
      <ThemePicker
        side="top"
        align="start"
        trigger={
          <button
            type="button"
            className="sidebar-actions-btn"
            aria-label="Theme"
            title="Theme"
          >
            <Palette size={15} strokeWidth={1.75} />
          </button>
        }
      />
      <button
        type="button"
        className="sidebar-actions-btn"
        onClick={handleConnectClick}
        onFocus={preloadConnectDialog}
        onMouseEnter={preloadConnectDialog}
        aria-label="Connect"
        title="Connect"
      >
        <Device size={15} />
        {connectHint.active && (
          <span className="sidebar-actions-btn-hint-dot" aria-hidden="true" />
        )}
      </button>
    </div>
  );
};

type PendingMenuAction = "settings" | "models" | "theme" | "connect" | null;

/**
 * Single gear-icon button rendered just below the account row in
 * rail / mini layouts where the four-button `SidebarActionsBar`
 * doesn't fit. Opens a popover menu with Settings / Models / Theme /
 * Connect.
 *
 * Models and Theme are themselves popovers. We render them with
 * hidden-but-anchored triggers next to the gear button and open
 * them in a controlled fashion when the matching menu item is
 * picked. The actual open is deferred to `onCloseAutoFocus` of the
 * dropdown so Radix doesn't restore focus to the gear button mid-
 * flight (same pattern as the avatar dropdown's sign-out flow).
 */
const SidebarActionsMenu = ({
  onConnect,
  onOpenSettings,
}: SidebarActionsBarProps) => {
  const connectHint = usePostOnboardingHint("connect");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const pendingActionRef = useRef<PendingMenuAction>(null);

  // Cross-component "open the model picker" trigger. Used by toasts that
  // surface tier/usage rejections so a single click on "Use my own key"
  // pops the picker right where the user already sees the active model.
  useEffect(() => {
    const handler = () => {
      preloadModelsPicker();
      setModelsOpen(true);
    };
    window.addEventListener("stella:open-model-picker", handler);
    return () => {
      window.removeEventListener("stella:open-model-picker", handler);
    };
  }, []);

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      const action = pendingActionRef.current;
      if (!action) return;
      pendingActionRef.current = null;
      event.preventDefault();
      if (action === "settings") {
        preloadSettingsScreen();
        onOpenSettings();
      } else if (action === "models") {
        setModelsOpen(true);
      } else if (action === "theme") {
        setThemeOpen(true);
      } else if (action === "connect") {
        preloadConnectDialog();
        if (connectHint.active) connectHint.dismiss();
        onConnect?.();
      }
    },
    [onOpenSettings, onConnect, connectHint],
  );

  return (
    <div className="sidebar-actions-bar">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="sidebar-actions-btn"
            aria-label="Quick settings"
            title="Quick settings"
            onFocus={() => {
              preloadSettingsScreen();
              preloadConnectDialog();
            }}
            onMouseEnter={() => {
              preloadSettingsScreen();
              preloadConnectDialog();
            }}
          >
            <SettingsIcon size={18} strokeWidth={1.75} />
            {connectHint.active && (
              <span
                className="sidebar-actions-btn-hint-dot"
                aria-hidden="true"
              />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <DropdownMenuItem
            onFocus={preloadSettingsScreen}
            onMouseEnter={preloadSettingsScreen}
            onSelect={() => {
              pendingActionRef.current = "settings";
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <SettingsIcon size={14} strokeWidth={1.75} />
            </span>
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onFocus={preloadModelsPicker}
            onMouseEnter={preloadModelsPicker}
            onSelect={() => {
              pendingActionRef.current = "models";
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <Cpu size={14} strokeWidth={1.75} />
            </span>
            Models
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              pendingActionRef.current = "theme";
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <Palette size={14} strokeWidth={1.75} />
            </span>
            Theme
          </DropdownMenuItem>
          <DropdownMenuItem
            onFocus={preloadConnectDialog}
            onMouseEnter={preloadConnectDialog}
            onSelect={() => {
              pendingActionRef.current = "connect";
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <Device size={14} />
            </span>
            Connect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ModelsPicker
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        hideTrigger
        side="top"
        align="start"
        trigger={
          <button
            type="button"
            className="sidebar-actions-anchor"
            aria-hidden="true"
            tabIndex={-1}
          />
        }
      />
      <ThemePicker
        open={themeOpen}
        onOpenChange={setThemeOpen}
        hideTrigger
        side="top"
        align="start"
        trigger={
          <button
            type="button"
            className="sidebar-actions-anchor"
            aria-hidden="true"
            tabIndex={-1}
          />
        }
      />
    </div>
  );
};

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
  onSignIn?: () => void;
  onConnect?: () => void;
  onNewApp?: () => void;
  onNewAppAskStella?: () => void;
}

const RAIL_STORAGE_KEY = "stella:sidebar:rail";

const readPersistedRail = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const writePersistedRail = (collapsed: boolean) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // localStorage can throw in private mode / sandboxed contexts; the
    // toggle is purely visual, so a silent no-op is the right thing.
  }
};

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
      className={`sidebar-nav-item${isActive ? " sidebar-nav-item--active" : ""}`}
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
        <Icon size={18} />
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
}

const AccountRow = ({ onSignIn, onUpgrade, onOpenFeedback }: AccountRowProps) => {
  const t = useT();
  const { user: convexUser, hasConnectedAccount } = useCurrentUser();
  // Better Auth's session payload already carries email/name for the
  // signed-in user, so use it as a reliable fallback while the Convex
  // one-shot identity query is still loading (or if it ever returns
  // null) — otherwise the avatar shows "?" until the query lands.
  const { user: sessionUser } = useAuthSessionState();
  const user = {
    email: convexUser?.email ?? sessionUser?.email ?? undefined,
    name: convexUser?.name ?? sessionUser?.name ?? undefined,
    isAnonymous: convexUser?.isAnonymous ?? sessionUser?.isAnonymous ?? undefined,
  };
  // Plans + the user's current tier are public-readable via the same backend
  // query the standalone Billing page uses; running it here lets the pill
  // render "Pro" / "Ultra" / etc. inline instead of always reading "Upgrade".
  //
  // The query is deferred to idle so the sidebar's first paint never waits
  // on Convex. Paid users see "Upgrade" for ~one idle tick, then snap to
  // their plan name; free users see "Upgrade" the whole time. The pill
  // route (`/billing`) still preloads on hover, so clicking is unaffected.
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
  // The one-shot read above only refetches when its `refreshKey` changes,
  // so a successful upgrade celebrated by `SubscriptionUpgradeDialog`
  // (Stripe webhook → Convex push) wouldn't otherwise flip the pill from
  // "Upgrade" to "Pro" until the next Sidebar remount. Listening for the
  // dispatched event lets the pill update inline without holding an open
  // Convex watcher for the rest of the session.
  const [billingRefreshKey, setBillingRefreshKey] = useState(0);
  useEffect(() => {
    const handler = () => setBillingRefreshKey((n) => n + 1);
    window.addEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
    return () =>
      window.removeEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
  }, []);
  // One-shot, not a subscription: the sidebar is always-on chrome, so
  // a live `useQuery` here held a Convex watcher open for the entire
  // session just to render a static "Pro"/"Plus" pill. Billing changes
  // re-fetch through Sidebar remounts after the `?billingCheckout=
  // complete` hand-off in `__root.tsx`.
  const billingStatus = useConvexOneShot(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount && billingQueryReady ? {} : "skip",
    billingRefreshKey,
  ) as BillingStatusLite | undefined;

  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);

  // Sign-out and Send-feedback both open a Dialog. Radix DropdownMenu restores
  // focus to its trigger (the avatar) when it closes — if we mounted the
  // Dialog during the item's onClick, the avatar would steal focus back from
  // the Dialog. Deferring the open to `onCloseAutoFocus` (with
  // `event.preventDefault()`) sidesteps that race; the pending refs flag
  // which dialog the close was intended to open.
  const pendingSignOutRef = useRef(false);
  const pendingFeedbackRef = useRef(false);

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
      }
    },
    [onOpenFeedback],
  );

  const handleConfirmSignOut = useCallback(() => {
    setSignOutConfirmOpen(false);
    void secureSignOut();
  }, []);

  if (!hasConnectedAccount) {
    return (
      <div className="sidebar-account">
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
            <LogIn size={18} />
          </span>
          <span className="sidebar-account-signin-label">
            {t("sidebar.signIn")}
          </span>
        </button>
      </div>
    );
  }

  const initials = initialsFromIdentity(user.email, user.name);
  const swatch = avatarSwatchFromIdentity(user.email ?? user.name);
  const plan = billingStatus?.plan;
  const isPaidPlan = Boolean(plan) && plan !== "free";
  const pillLabel = isPaidPlan
    ? planLabel(plan, billingStatus)
    : t("sidebar.upgrade");

  return (
    <div className="sidebar-account">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="sidebar-account-avatar"
            title={user.email ?? user.name ?? t("sidebar.account")}
            aria-label={t("sidebar.account")}
            style={{
              background: swatch.background,
              color: swatch.color,
              borderColor: swatch.border,
            }}
          >
            {initials}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          onCloseAutoFocus={handleDropdownCloseAutoFocus}
        >
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
      <button
        type="button"
        className={
          "sidebar-account-pill" +
          (isPaidPlan ? " sidebar-account-pill--plan" : " sidebar-account-pill--upgrade")
        }
        onClick={() => {
          preloadBillingScreen();
          onUpgrade();
        }}
        onFocus={preloadBillingScreen}
        onMouseEnter={preloadBillingScreen}
        title={isPaidPlan ? `${pillLabel} plan — manage billing` : "Upgrade your plan"}
        aria-label={isPaidPlan ? `${pillLabel} plan` : "Upgrade your plan"}
      >
        {pillLabel}
      </button>
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

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const TitleBarSpacer = () => <div className="sidebar-titlebar" />;

export const Sidebar = ({
  className,
  onSignIn,
  onConnect,
  onNewApp,
  onNewAppAskStella,
}: SidebarProps) => {
  const handleAskStella = onNewAppAskStella ?? onNewApp;
  const navigate = useNavigate();
  const pageOverride = usePageSidebarOverride();
  const defaultBack = useDefaultPageSidebarBack();

  // Subscribe to the app registry so HMR additions (new sidebar apps
  // dropped by the agent) re-render the lists without a full reload.
  const allApps = useRegisteredApps();
  const { topApps, bottomApps } = useMemo(() => {
    // Apps can opt out of permanent rail rendering via `hideFromSidebar`
    // — the route stays reachable but the sidebar skips it. Used by
    // Settings, which now lives in the avatar dropdown.
    const visible = allApps.filter((a) => !a.hideFromSidebar);
    return {
      topApps: visible.filter((a) => a.slot === "top"),
      bottomApps: visible.filter((a) => a.slot === "bottom"),
    };
  }, [allApps]);

  // User-toggled rail (icon-only) collapse. Persisted in localStorage so the
  // preference survives reloads. The window-mode "mini" mode is a separate
  // concept and is forced compact via CSS regardless of this state.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(readPersistedRail);

  // Mini windows render the sidebar as a rail via the `max-width: 600px`
  // media query without flipping `railCollapsed`. Track that here so the
  // actions row can swap to the single-button menu in either rail mode.
  const [isCompactRail, setIsCompactRail] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 600px)").matches;
  });

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const sync = () => setIsCompactRail(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const railMode = railCollapsed || isCompactRail;

  const toggleRailCollapsed = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      writePersistedRail(next);
      return next;
    });
  }, []);

  useEffect(() => {
    window.electronAPI?.window.setNativeButtonsVisible(true);
  }, []);

  useEffect(() => {
    window.addEventListener(
      STELLA_TOGGLE_SIDEBAR_RAIL_EVENT,
      toggleRailCollapsed,
    );
    return () => {
      window.removeEventListener(
        STELLA_TOGGLE_SIDEBAR_RAIL_EVENT,
        toggleRailCollapsed,
      );
    };
  }, [toggleRailCollapsed]);

  const handleBrandClick = useCallback(() => {
    toggleRailCollapsed();
  }, [toggleRailCollapsed]);

  const handleUpgrade = useCallback(() => {
    void navigate({ to: "/billing" });
  }, [navigate]);

  const handleOpenSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  // Auto-prompted feedback. The hook tracks active (visible + focused) time
  // across the whole shell and flips `shouldPrompt` once the user has been
  // active for ~30 minutes today AND it's been ≥24h since the last prompt.
  // We mount the dialog at the Sidebar root (not inside `AccountRow`) so it
  // still appears on routes that render a page-sidebar override.
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
    // Ack immediately on auto-open so the cooldown starts now — even if the
    // user dismisses without sending we don't want to re-prompt them this
    // session (or for the next 24 hours).
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

  // One-time post-onboarding nudge for the Store entry. Mirrors the
  // Connect dot shown in the actions bar and is dismissed the moment
  // the user actually lands on `/store` — by clicking the entry, by
  // a deeper nav, or by a deep link.
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
    if (railCollapsed) parts.push("sidebar--rail");
    return parts.join(" ");
  }, [className, railCollapsed]);

  // Mirror the rail-collapsed state onto the document root so absolutely
  // positioned chrome above the sidebar (e.g. the topbar's centered store
  // tabs) can pick the correct width when computing offsets.
  useEffect(() => {
    const root = document.documentElement;
    if (railCollapsed) root.dataset.sidebarRail = "true";
    else delete root.dataset.sidebarRail;
  }, [railCollapsed]);

  // The brand row is a button so it can also be the rail-toggle target.
  // Wrapping the icon + (optionally hidden) text gives us a single focusable
  // surface that works both as "click to collapse" and "click to expand".
  const brandRow: ReactNode = (
    <button
      type="button"
      className="sidebar-brand"
      onClick={handleBrandClick}
      title={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-pressed={railCollapsed}
    >
      <span className="sidebar-brand-logo" aria-hidden="true">
        <img src="stella-logo.svg" alt="" className="sidebar-brand-logo-art" />
      </span>
      <span className="sidebar-brand-text">Stella</span>
    </button>
  );

  return (
    <aside className={sidebarClass}>
      <div className="sidebar-stack">
        <TitleBarSpacer />
        {brandRow}
        {pageOverride ? (
          // Page-sidebar override mode: a route (e.g. /settings) has
          // registered its own nav via <PageSidebar>. We swap out the
          // default top-nav + footer for the override content, prepended
          // with a Back button. Account row stays hidden in this mode so
          // the page nav has the full vertical canvas — Back returns to
          // the previous route which restores it.
          <nav className="sidebar-nav sidebar-nav--page-override">
            <button
              type="button"
              className="sidebar-page-back"
              onClick={defaultBack}
              title="Back"
              aria-label="Back"
            >
              <span className="sidebar-nav-icon">
                <ArrowLeft size={18} />
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
              {topApps.map((app) => (
                <AppNavItem
                  key={app.id}
                  app={app}
                  badgeCount={badgeCountForApp(app)}
                  showHintDot={showHintForApp(app)}
                  onHintDismiss={() => dismissHintForApp(app)}
                />
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="sidebar-nav-item"
                    title="New App"
                    aria-label="New App"
                  >
                    <span className="sidebar-nav-icon">
                      <PlusSquare size={18} />
                    </span>
                    <span className="sidebar-nav-label">New App</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start">
                  <DropdownMenuItem onClick={handleAskStella}>
                    Ask Stella
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </nav>
            <div className="sidebar-footer">
              {bottomApps.map((app) => (
                <AppNavItem
                  key={app.id}
                  app={app}
                  badgeCount={badgeCountForApp(app)}
                  showHintDot={showHintForApp(app)}
                  onHintDismiss={() => dismissHintForApp(app)}
                />
              ))}
              <AccountRow
                onSignIn={onSignIn}
                onUpgrade={handleUpgrade}
                onOpenFeedback={handleOpenFeedback}
              />
              {railMode ? (
                <SidebarActionsMenu
                  onConnect={onConnect}
                  onOpenSettings={handleOpenSettings}
                />
              ) : (
                <SidebarActionsBar
                  onConnect={onConnect}
                  onOpenSettings={handleOpenSettings}
                />
              )}
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
