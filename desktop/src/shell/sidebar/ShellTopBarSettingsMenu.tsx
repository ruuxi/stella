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
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { SUBSCRIPTION_UPGRADED_EVENT } from "@/global/billing/SubscriptionUpgradeDialog";
import {
  CreditCard,
  MessageSquare,
  Palette,
  Settings as SettingsIcon,
} from "lucide-react";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { useT } from "@/shared/i18n";
import { api } from "@/convex/api";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import {
  preloadBillingScreen,
  preloadConnectDialog,
  preloadSidebarRoute,
} from "@/shared/lib/sidebar-preloads";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { CustomDevice as Device } from "./SidebarIcons";
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

interface ShellTopBarSettingsMenuProps {
  onConnect?: () => void;
}

export const ShellTopBarSettingsMenu = ({
  onConnect,
}: ShellTopBarSettingsMenuProps) => {
  const t = useT();
  const navigate = useNavigate();
  const { hasConnectedAccount } = useCurrentUser();

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

  const pendingFeedbackRef = useRef(false);
  const pendingConnectRef = useRef(false);
  const pendingSettingsRef = useRef(false);
  const pendingThemeRef = useRef(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

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
      }
    },
    [handleOpenFeedback, handleOpenSettings, handleOpenConnect],
  );

  const plan = billingStatus?.plan;
  const isPaidPlan = Boolean(plan) && plan !== "free";
  const pillLabel = isPaidPlan
    ? planLabel(plan, billingStatus)
    : t("sidebar.upgrade");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shell-topbar-icon-btn shell-topbar-nav-settings-btn"
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon size={15} strokeWidth={1.75} />
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
          align="start"
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
          {hasConnectedAccount ? (
            <>
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
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ThemePicker
        open={themePickerOpen}
        onOpenChange={setThemePickerOpen}
        hideTrigger
        side="bottom"
        align="start"
        trigger={
          <button
            type="button"
            className="shell-topbar-settings-theme-anchor"
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
    </>
  );
};
