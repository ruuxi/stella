import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import {
  findApiKey,
  findOauthCredential,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import { api } from "@/convex/api";
import { router } from "@/router";
import { openEngineDisplayTab } from "@/features/workspace-display/default-tabs";
import { useT } from "@/shared/i18n";
import { getSettingsErrorMessage } from "./shared";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type ChronicleStatus = {
  enabled: boolean;
  running: boolean;
  paused?: boolean;
  fps?: number;
  captures?: number;
  lastCaptureAt?: number | null;
};

function formatPendingDreamInputs(
  pendingThreadSummaries: number,
  pendingExtensions: number,
  t: TFunction,
): string | undefined {
  const parts: string[] = [];
  if (pendingThreadSummaries > 0) {
    parts.push(
      t(
        pendingThreadSummaries === 1
          ? "settings.memory.dreamResults.pendingThreadSummary"
          : "settings.memory.dreamResults.pendingThreadSummaries",
        { count: pendingThreadSummaries },
      ),
    );
  }
  if (pendingExtensions > 0) {
    parts.push(
      t(
        pendingExtensions === 1
          ? "settings.memory.dreamResults.pendingExtension"
          : "settings.memory.dreamResults.pendingExtensions",
        { count: pendingExtensions },
      ),
    );
  }
  return parts.length > 0
    ? t("settings.memory.dreamResults.pendingPrefix", {
        items: parts.join(t("settings.memory.dreamResults.pendingJoin")),
      })
    : undefined;
}

function formatChronicleEnableFailure(
  args: {
    reason?: string;
    detail?: string;
  },
  t: TFunction,
): string {
  switch (args.reason) {
    case "no-stella-root":
      return t("settings.memory.enableFailures.noStellaAppDir");
    case "needs-permission":
      return t("settings.memory.enableFailures.needsPermission");
    case "binary-missing":
      return t("settings.memory.enableFailures.binaryMissing");
    case "startup-timeout":
      return t("settings.memory.enableFailures.startupTimeout");
    case "unsupported-platform":
      return t("settings.memory.enableFailures.unsupportedPlatform");
    default:
      return (
        args.detail ??
        args.reason ??
        t("settings.memory.enableFailures.unknown")
      );
  }
}

function formatDreamRunResult(
  args: {
    ok: boolean;
    reason?: string;
    pendingThreadSummaries: number;
    pendingExtensions: number;
    detail?: string;
  },
  t: TFunction,
): string | undefined {
  const pending = formatPendingDreamInputs(
    args.pendingThreadSummaries,
    args.pendingExtensions,
    t,
  );
  switch (args.reason) {
    case "scheduled":
      return pending ?? t("settings.memory.dreamResults.scheduled");
    case "in_flight":
      return t("settings.memory.dreamResults.inFlight");
    case "no_inputs":
      return t("settings.memory.dreamResults.noInputs");
    case "no_api_key":
      return t("settings.memory.dreamResults.noApiKey");
    case "disabled":
      return t("settings.memory.dreamResults.disabled");
    case "below_threshold":
      return pending ?? t("settings.memory.dreamResults.belowThreshold");
    case "lock_busy":
      return t("settings.memory.dreamResults.lockBusy");
    case "no-runner":
      return t("settings.memory.dreamResults.noRunner");
    case "no-stella-root":
      return t("settings.memory.enableFailures.noStellaAppDir");
    case "unavailable":
      return args.detail ?? t("settings.memory.dreamResults.unavailable");
    default:
      return args.detail ?? args.reason ?? pending;
  }
}

function ChronicleSettingsCard() {
  const t = useT();
  const chronicleApi = window.electronAPI?.chronicle;
  const { hasConnectedAccount, isLoading: authLoading } =
    useAuthSessionState();
  const [billingNowMs] = useState(() => Date.now());
  const billingStatus = useConvexOneShot(api.billing.getSubscriptionStatus, {
    now: billingNowMs,
  });
  const credentials = useLlmCredentials();
  const [chronicleOverride, setChronicleOverride] = useState<string>("");
  const [chronicleOverrideLoaded, setChronicleOverrideLoaded] =
    useState<boolean>(false);

  // Pull the current chronicle model override from local preferences so we
  // can tell whether the user has set up a BYOK route for it. The picker
  // dispatches `stella:local-model-preferences-changed` whenever it
  // mutates, so we reload then too.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const prefs =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
        if (cancelled) return;
        setChronicleOverride(prefs?.modelOverrides?.chronicle ?? "");
        setChronicleOverrideLoaded(true);
      } catch {
        if (!cancelled) setChronicleOverrideLoaded(true);
      }
    };
    void load();
    const onChange = () => {
      void load();
    };
    window.addEventListener(
      "stella:local-model-preferences-changed",
      onChange,
    );
    return () => {
      cancelled = true;
      window.removeEventListener(
        "stella:local-model-preferences-changed",
        onChange,
      );
    };
  }, []);

  // Chronicle ticks every minute against the user's captured screen
  // activity. On Stella's provider it's locked to a cheap model and
  // gated to paid plans (the cost is real). On BYOK the user owns the
  // bill — we let them enable it without a sign-in or subscription as
  // long as they've actually pointed the chronicle agent at a provider
  // they have credentials for.
  const chronicleProvider = useMemo(() => {
    const slash = chronicleOverride.indexOf("/");
    return slash > 0 ? chronicleOverride.slice(0, slash) : "";
  }, [chronicleOverride]);
  const hasChronicleByokCredential = useMemo(() => {
    if (!chronicleProvider || chronicleProvider === "stella") return false;
    return Boolean(
      findApiKey(credentials.apiKeys, chronicleProvider) ??
        findOauthCredential(credentials.oauthCredentials, chronicleProvider),
    );
  }, [
    chronicleProvider,
    credentials.apiKeys,
    credentials.oauthCredentials,
  ]);
  const hasStellaPaidPlan =
    hasConnectedAccount &&
    billingStatus !== undefined &&
    billingStatus.plan !== "free";
  const canEnable = hasChronicleByokCredential || hasStellaPaidPlan;
  const billingLoading =
    hasConnectedAccount &&
    billingStatus === undefined &&
    !hasChronicleByokCredential;
  const credentialsLoading =
    !chronicleOverrideLoaded || credentials.loading;
  const accessLoading = authLoading || billingLoading || credentialsLoading;
  const [available, setAvailable] = useState<boolean>(true);
  const [status, setStatus] = useState<ChronicleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "toggle" | "dream" | "wipe" | "open">(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!chronicleApi?.status) {
      setAvailable(false);
      setLoading(false);
      return;
    }
    try {
      const result = await chronicleApi.status();
      setAvailable(result.available);
      setStatus(result.status ?? null);
      setError(null);
    } catch (caught) {
      setError(
        getSettingsErrorMessage(
          caught,
          t("settings.memory.errors.loadStatus"),
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [chronicleApi, t]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const openChronicleModelPicker = () => {
    // Models live in the workspace panel's Engine tab now; open it
    // alongside /chat so the user lands on the picker without
    // bouncing through another settings page.
    void router.navigate({ to: "/chat" });
    openEngineDisplayTab();
  };

  const handleToggle = async (next: boolean) => {
    if (!chronicleApi?.setEnabled) return;
    if (next && !canEnable) {
      // Two failure modes; pick the most actionable copy. If they're
      // anonymous it's "sign in or BYOK"; if they're on Stella free
      // it's "upgrade or BYOK". Either way the BYOK link opens the
      // workspace panel's Engine tab on the Models section.
      const message = !hasConnectedAccount
        ? t("settings.memory.access.signInMessage")
        : t("settings.memory.access.upgradeMessage");
      setError(message);
      showToast({
        title: !hasConnectedAccount
          ? t("settings.memory.access.signInTitle")
          : t("settings.memory.access.subscriptionTitle"),
        description: message,
        variant: "error",
        action: {
          label: t("settings.memory.access.pickModel"),
          onClick: openChronicleModelPicker,
        },
        secondaryAction: !hasConnectedAccount
          ? undefined
          : {
              label: t("settings.memory.access.upgrade"),
              onClick: () => {
                void router.navigate({ to: "/billing" });
              },
            },
      });
      return;
    }
    setBusy("toggle");
    setError(null);
    try {
      const result = await chronicleApi.setEnabled(next);
      if (!result.ok) {
        const message = formatChronicleEnableFailure(result, t);
        setError(message);
        showToast({
          title: next
            ? t("settings.memory.toasts.enableFailedTitle")
            : t("settings.memory.toasts.disableFailedTitle"),
          description: message,
          variant: "error",
        });
      } else {
        showToast({
          title: next
            ? t("settings.memory.toasts.enabledTitle")
            : t("settings.memory.toasts.disabledTitle"),
          description:
            result.reason === "already-running"
              ? t("settings.memory.toasts.alreadyRunning")
              : undefined,
          variant: "default",
        });
      }
      await refresh();
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, t("settings.memory.errors.update")),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDreamNow = async () => {
    if (!chronicleApi?.dreamNow) return;
    setBusy("dream");
    setError(null);
    try {
      const result = await chronicleApi.dreamNow();
      const description = formatDreamRunResult(result, t);
      showToast({
        title: result.ok
          ? t("settings.memory.toasts.dreamScheduledTitle")
          : t("settings.memory.toasts.dreamNotScheduledTitle"),
        description,
        variant: result.ok ? "success" : "error",
      });
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, t("settings.memory.errors.dream")),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleOpenFolder = async () => {
    if (!chronicleApi?.openMemoriesFolder) return;
    setBusy("open");
    try {
      await chronicleApi.openMemoriesFolder();
    } finally {
      setBusy(null);
    }
  };

  const handleWipe = async () => {
    if (!chronicleApi?.wipeMemories) return;
    const confirmed = window.confirm(t("settings.memory.erase.confirm"));
    if (!confirmed) return;
    setBusy("wipe");
    setError(null);
    try {
      const result = await chronicleApi.wipeMemories();
      if (!result.ok) {
        const message = result.reason ?? t("settings.memory.errors.wipe");
        setError(message);
        showToast({
          title: t("settings.memory.toasts.wipeFailedTitle"),
          description: message,
          variant: "error",
        });
        return;
      }
      showToast({
        title: t("settings.memory.toasts.wipedTitle"),
        variant: "success",
      });
      await refresh();
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, t("settings.memory.errors.wipe")),
      );
    } finally {
      setBusy(null);
    }
  };

  if (!available && !loading) {
    return null;
  }

  const enabled = Boolean(status?.enabled);
  const running = Boolean(status?.running);
  const fps = status?.fps;
  const lastCaptureAt = status?.lastCaptureAt ?? null;
  const screenMemoryDescription =
    accessLoading || canEnable
      ? t("settings.memory.screen.description")
      : !hasConnectedAccount
        ? t("settings.memory.screen.signInDescription")
        : t("settings.memory.screen.upgradeDescription");
  const statusDescription = loading
    ? t("common.loading")
    : enabled
      ? `${running ? t("settings.memory.status.running") : t("settings.memory.status.stopped")}${
          typeof fps === "number"
            ? ` · ${t("settings.memory.status.fps", { fps: fps.toFixed(2) })}`
            : ""
        }${
          lastCaptureAt
            ? ` · ${t("settings.memory.status.lastCapture", {
                time: new Date(lastCaptureAt).toLocaleTimeString(),
              })}`
            : ""
        }`
      : t("settings.memory.status.disabled");

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">{t("settings.memory.title")}</h3>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.memory.screen.label")}
          </div>
          <div className="settings-row-sublabel">
            {screenMemoryDescription}
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={busy !== null || loading || accessLoading}
            onClick={() => handleToggle(!enabled)}
          >
            {busy === "toggle"
              ? t("settings.memory.working")
              : enabled
                ? t("settings.memory.disable")
                : t("settings.memory.enable")}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.memory.status.label")}
          </div>
          <div className="settings-row-sublabel">{statusDescription}</div>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.memory.folder.label")}
          </div>
          <div className="settings-row-sublabel">
            {t("settings.memory.folder.description")}
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={busy !== null}
            onClick={handleOpenFolder}
          >
            {busy === "open"
              ? t("settings.memory.folder.opening")
              : t("settings.memory.folder.open")}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.memory.update.label")}
          </div>
          <div className="settings-row-sublabel">
            {t("settings.memory.update.description")}
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={busy !== null}
            onClick={handleDreamNow}
          >
            {busy === "dream"
              ? t("settings.memory.update.running")
              : t("settings.memory.update.run")}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.memory.erase.label")}
          </div>
          <div className="settings-row-sublabel">
            {t("settings.memory.erase.description")}
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn pill-btn--danger"
            disabled={busy !== null}
            onClick={handleWipe}
          >
            {busy === "wipe"
              ? t("settings.memory.erase.working")
              : t("settings.memory.erase.action")}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-sublabel settings-card-desc--error">
              {error}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function MemoryTab() {
  return (
    <div className="settings-tab-content">
      <ChronicleSettingsCard />
    </div>
  );
}
