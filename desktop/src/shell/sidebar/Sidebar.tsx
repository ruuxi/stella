import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { LogOut, Palette, Settings as SettingsIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AppMetadata } from "@/apps/_shared/app-metadata";
import { api } from "@/convex/api";
import { useTheme } from "@/context/theme-context";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { secureSignOut } from "@/global/auth/services/auth";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { getPlatform } from "@/platform/electron/platform";
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
import { ShiftingGradient } from "../background/ShiftingGradient";
import {
  CustomDevice as Device,
  CustomLogIn as LogIn,
  CustomPlusSquare as PlusSquare,
} from "./SidebarIcons";
import "./sidebar.css";

/**
 * App discovery: every `desktop/src/apps/<id>/metadata.ts` is loaded eagerly
 * by Vite at build time, sorted by `order`, and split into top / bottom slots.
 *
 * Add a new app by dropping a `metadata.ts` into `desktop/src/apps/<id>/`.
 * No edits to this file are needed.
 */
const APP_MODULES = import.meta.glob<{ default: AppMetadata }>(
  "../../apps/*/metadata.ts",
  { eager: true },
);

const ALL_APPS: AppMetadata[] = Object.values(APP_MODULES)
  .map((m) => m.default)
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

// Apps can opt out of permanent rail rendering via `hideFromSidebar` — the
// route stays reachable but the sidebar skips it. Used by Settings, which
// now lives in the avatar dropdown.
const VISIBLE_APPS = ALL_APPS.filter((a) => !a.hideFromSidebar);
const TOP_APPS = VISIBLE_APPS.filter((a) => a.slot === "top");
const BOTTOM_APPS = VISIBLE_APPS.filter((a) => a.slot === "bottom");

interface SidebarProps {
  className?: string;
  onSignIn?: () => void;
  onConnect?: () => void;
  onNewApp?: () => void;
  onNewAppAskStella?: () => void;
}

const MAXIMIZE_STATE_SYNC_DELAY_MS = 50;

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

const WindowControls = () => {
  const [isMaximized, setIsMaximized] = useState(false);

  const updateMaximizedState = useCallback(() => {
    const promise = window.electronAPI?.window.isMaximized?.();
    if (!promise) return;
    void promise.then((maximized) => setIsMaximized(Boolean(maximized)));
  }, []);

  useEffect(() => {
    updateMaximizedState();
  }, [updateMaximizedState]);

  return (
    <div className="sidebar-window-controls">
      <button
        className="sidebar-wc-btn"
        onClick={() => window.electronAPI?.window.minimize?.()}
        aria-label="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className="sidebar-wc-btn"
        onClick={() => {
          window.electronAPI?.window.maximize?.();
          window.setTimeout(updateMaximizedState, MAXIMIZE_STATE_SYNC_DELAY_MS);
        }}
        aria-label={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path fill="none" stroke="currentColor" strokeWidth="1" d="M2.5 0.5h7v7h-7zM0.5 2.5v7h7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        className="sidebar-wc-btn sidebar-wc-close"
        onClick={() => window.electronAPI?.window.close?.()}
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path stroke="currentColor" strokeWidth="1.2" d="M1 1l8 8M9 1l-8 8" />
        </svg>
      </button>
    </div>
  );
};

interface AppNavItemProps {
  app: AppMetadata;
}

const AppNavItem = ({ app }: AppNavItemProps) => {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(matchRoute({ to: app.route }));
  const Icon = app.icon;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (isActive && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
      }
    },
    [isActive, app],
  );

  return (
    <Link
      to={app.route}
      className={`sidebar-nav-item${isActive ? " sidebar-nav-item--active" : ""}`}
      onClick={handleClick}
      title={app.label}
    >
      <span className="sidebar-nav-icon">
        <Icon size={18} />
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
  onOpenSettings: () => void;
}

const AccountRow = ({ onSignIn, onUpgrade, onOpenSettings }: AccountRowProps) => {
  const { user, hasConnectedAccount } = useCurrentUser();
  // Plans + the user's current tier are public-readable via the same backend
  // query the standalone Billing page uses; running it here lets the pill
  // render "Pro" / "Ultra" / etc. inline instead of always reading "Upgrade".
  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
  ) as BillingStatusLite | undefined;

  // The Theme item in the avatar menu opens the existing ThemePicker popover.
  // We render a hidden popover trigger inside this row so the popover anchors
  // visually near the avatar; the dropdown closes on item-select and the
  // popover takes over from there.
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);

  // Tracks which menu item triggered the dropdown close, so the dropdown's
  // `onCloseAutoFocus` handler can take over instead of letting focus race.
  //
  // Why this matters: Radix DropdownMenu restores focus to its trigger
  // (the avatar) when it closes. If we open the ThemePicker popover during
  // the item's onClick, Radix Popover mounts BEFORE that focus restoration,
  // then immediately sees focus move "outside" its content and fires
  // `onFocusOutside` → the popover closes again. Doing the open inside
  // `onCloseAutoFocus` (and `event.preventDefault()`-ing the focus restore)
  // sidesteps that race entirely. A `setTimeout` / `requestAnimationFrame`
  // workaround does not help because the focus restoration is what closes
  // the popover, not the timing of the open.
  const pendingActionRef = useRef<null | "theme" | "signout">(null);

  const handleDropdownCloseAutoFocus = useCallback(
    (event: Event) => {
      const next = pendingActionRef.current;
      if (!next) return;
      pendingActionRef.current = null;
      event.preventDefault();
      if (next === "theme") {
        setThemePickerOpen(true);
      } else if (next === "signout") {
        setSignOutConfirmOpen(true);
      }
    },
    [],
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
          onClick={() => onSignIn?.()}
          title="Sign in"
        >
          <span className="sidebar-account-signin-icon">
            <LogIn size={18} />
          </span>
          <span className="sidebar-account-signin-label">Sign in</span>
        </button>
      </div>
    );
  }

  const initials = initialsFromIdentity(user?.email, user?.name);
  const plan = billingStatus?.plan;
  const isPaidPlan = Boolean(plan) && plan !== "free";
  const pillLabel = isPaidPlan ? planLabel(plan, billingStatus) : "Upgrade";

  return (
    <div className="sidebar-account">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="sidebar-account-avatar"
            title={user?.email ?? user?.name ?? "Account"}
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
          <DropdownMenuItem onClick={onOpenSettings}>
            <span data-slot="dropdown-menu-item-icon">
              <SettingsIcon size={14} strokeWidth={1.75} />
            </span>
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              pendingActionRef.current = "theme";
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <Palette size={14} strokeWidth={1.75} />
            </span>
            Theme
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-variant="destructive"
            onClick={() => {
              pendingActionRef.current = "signout";
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <LogOut size={14} strokeWidth={1.75} />
            </span>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        className={
          "sidebar-account-pill" +
          (isPaidPlan ? " sidebar-account-pill--plan" : " sidebar-account-pill--upgrade")
        }
        onClick={onUpgrade}
        title={isPaidPlan ? `${pillLabel} plan — manage billing` : "Upgrade your plan"}
      >
        {pillLabel}
      </button>
      {/* Hidden trigger anchors the ThemePicker popover near the avatar. The
          parent `.sidebar-account` is `position: relative`, so the absolutely
          positioned hidden trigger sits over the avatar and the popover
          opens on the `top` side of it. */}
      <ThemePicker
        hideTrigger
        open={themePickerOpen}
        onOpenChange={setThemePickerOpen}
        onThemeSelect={() => setThemePickerOpen(false)}
        side="top"
        align="start"
        trigger={
          <button
            type="button"
            aria-label="Theme"
            className="sidebar-account-theme-anchor"
          />
        }
      />
      <Dialog open={signOutConfirmOpen} onOpenChange={setSignOutConfirmOpen}>
        <DialogContent fit aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Sign out of Stella?</DialogTitle>
          </DialogHeader>
          <DialogDescription>Are you sure?</DialogDescription>
          <div className="sidebar-confirm-actions">
            <Button
              variant="ghost"
              size="large"
              onClick={() => setSignOutConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={handleConfirmSignOut}
              data-tone="destructive"
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

interface TitleBarRowProps {
  isMac: boolean;
  /** When true (compact / rail), the row collapses to a thin spacer so traffic
   * lights still have somewhere to live but the window controls hide. */
  compact: boolean;
}

const TitleBarRow = ({ isMac, compact }: TitleBarRowProps) => (
  <div
    className={
      `sidebar-titlebar${isMac ? " sidebar-titlebar--mac" : ""}` +
      (compact ? " sidebar-titlebar--compact" : "")
    }
  >
    {!compact && !isMac ? <WindowControls /> : null}
  </div>
);

export const Sidebar = ({
  className,
  onSignIn,
  onConnect,
  onNewApp,
  onNewAppAskStella,
}: SidebarProps) => {
  const { gradientMode, gradientColor } = useTheme();
  const isMac = getPlatform() === "darwin";
  const handleAskStella = onNewAppAskStella ?? onNewApp;
  const navigate = useNavigate();

  // User-toggled rail (icon-only) collapse. Persisted in localStorage so the
  // preference survives reloads. The window-mode "mini" mode is a separate
  // concept and is forced compact via CSS regardless of this state.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(readPersistedRail);

  const handleBrandClick = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      writePersistedRail(next);
      return next;
    });
  }, []);

  const handleUpgrade = useCallback(() => {
    void navigate({ to: "/billing" });
  }, [navigate]);

  const handleOpenSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  const sidebarClass = useMemo(() => {
    const parts = ["sidebar"];
    if (className) parts.push(className);
    if (railCollapsed) parts.push("sidebar--rail");
    return parts.join(" ");
  }, [className, railCollapsed]);

  // The brand row is a button so it can also be the rail-toggle target.
  // Wrapping the icon + (optionally hidden) text gives us a single focusable
  // surface that works both as "click to collapse" and "click to expand".
  const brandRow: ReactNode = (
    <button
      type="button"
      className="sidebar-brand"
      onClick={handleBrandClick}
      title={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
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
      <ShiftingGradient
        mode={gradientMode}
        colorMode={gradientColor}
        contained
      />
      <div className="sidebar-stack">
        <TitleBarRow isMac={isMac} compact={railCollapsed} />
        {brandRow}
        <nav className="sidebar-nav">
          {TOP_APPS.map((app) => (
            <AppNavItem key={app.id} app={app} />
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="sidebar-nav-item"
                title="New App"
              >
                <span className="sidebar-nav-icon">
                  <PlusSquare size={18} />
                </span>
                <span className="sidebar-nav-label">New App</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start">
              <DropdownMenuItem onClick={handleAskStella}>Ask Stella</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
        <div className="sidebar-footer">
          {BOTTOM_APPS.map((app) => (
            <AppNavItem key={app.id} app={app} />
          ))}
          <button
            type="button"
            className="sidebar-nav-item"
            onClick={onConnect}
            title="Connect"
          >
            <span className="sidebar-nav-icon">
              <Device size={18} />
            </span>
            <span className="sidebar-nav-label">Connect</span>
          </button>
          <AccountRow
            onSignIn={onSignIn}
            onUpgrade={handleUpgrade}
            onOpenSettings={handleOpenSettings}
          />
        </div>
      </div>
    </aside>
  );
};
