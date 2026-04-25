import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ArrowLeft, LogOut } from "lucide-react";
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
import {
  useDefaultPageSidebarBack,
  usePageSidebarOverride,
} from "@/context/page-sidebar";
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
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
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
      aria-label={app.label}
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
}

const AccountRow = ({ onSignIn, onUpgrade }: AccountRowProps) => {
  const { user, hasConnectedAccount } = useCurrentUser();
  // Plans + the user's current tier are public-readable via the same backend
  // query the standalone Billing page uses; running it here lets the pill
  // render "Pro" / "Ultra" / etc. inline instead of always reading "Upgrade".
  const billingStatus = useQuery(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
  ) as BillingStatusLite | undefined;

  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);

  // Sign-out opens a confirm Dialog. Radix DropdownMenu restores focus to its
  // trigger (the avatar) when it closes — if we mounted the Dialog during
  // the item's onClick, the avatar would steal focus back from the Dialog.
  // Deferring the open to `onCloseAutoFocus` (with `event.preventDefault()`)
  // sidesteps that race; `pendingSignOutRef` flags that the close was
  // intentional rather than a stray dismissal.
  const pendingSignOutRef = useRef(false);

  const handleDropdownCloseAutoFocus = useCallback((event: Event) => {
    if (!pendingSignOutRef.current) return;
    pendingSignOutRef.current = false;
    event.preventDefault();
    setSignOutConfirmOpen(true);
  }, []);

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
          aria-label="Sign in"
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
            aria-label="Account"
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
            data-variant="destructive"
            onClick={() => {
              pendingSignOutRef.current = true;
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
        aria-label={isPaidPlan ? `${pillLabel} plan` : "Upgrade your plan"}
      >
        {pillLabel}
      </button>
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

  // User-toggled rail (icon-only) collapse. Persisted in localStorage so the
  // preference survives reloads. The window-mode "mini" mode is a separate
  // concept and is forced compact via CSS regardless of this state.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(readPersistedRail);

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
              {TOP_APPS.map((app) => (
                <AppNavItem key={app.id} app={app} />
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
              {BOTTOM_APPS.map((app) => (
                <AppNavItem key={app.id} app={app} />
              ))}
              <button
                type="button"
                className="sidebar-nav-item"
                onClick={onConnect}
                title="Connect"
                aria-label="Connect"
              >
                <span className="sidebar-nav-icon">
                  <Device size={18} />
                </span>
                <span className="sidebar-nav-label">Connect</span>
              </button>
              <AccountRow onSignIn={onSignIn} onUpgrade={handleUpgrade} />
            </div>
          </>
        )}
      </div>
    </aside>
  );
};
