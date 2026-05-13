import { useCallback, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { api } from "@/convex/api";
import { router } from "@/router";
import { getSettingsErrorMessage } from "./shared";

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
): string | undefined {
  const parts: string[] = [];
  if (pendingThreadSummaries > 0) {
    parts.push(
      `${pendingThreadSummaries} task ${pendingThreadSummaries === 1 ? "summary" : "summaries"}`,
    );
  }
  if (pendingExtensions > 0) {
    parts.push(
      `${pendingExtensions} Chronicle ${pendingExtensions === 1 ? "file" : "files"}`,
    );
  }
  return parts.length > 0 ? `Pending: ${parts.join(" and ")}.` : undefined;
}

function formatChronicleEnableFailure(args: {
  reason?: string;
  detail?: string;
}): string {
  switch (args.reason) {
    case "no-stella-root":
      return "Stella's workspace root is unavailable.";
    case "needs-permission":
      return "Screen Recording permission is still required before Chronicle can start.";
    case "binary-missing":
      return "The Chronicle helper binary is missing.";
    case "startup-timeout":
      return "Chronicle did not come online after launch.";
    case "unsupported-platform":
      return "Chronicle is only available on macOS.";
    default:
      return args.detail ?? args.reason ?? "Unknown error.";
  }
}

function formatDreamRunResult(args: {
  ok: boolean;
  reason?: string;
  pendingThreadSummaries: number;
  pendingExtensions: number;
  detail?: string;
}): string | undefined {
  const pending = formatPendingDreamInputs(
    args.pendingThreadSummaries,
    args.pendingExtensions,
  );
  switch (args.reason) {
    case "scheduled":
      return pending ?? "Dream will consolidate the current backlog.";
    case "in_flight":
      return "A Dream pass is already running.";
    case "no_inputs":
      return "There is nothing new to consolidate right now.";
    case "no_api_key":
      return "Dream needs a configured model/API key or signed-in Stella route.";
    case "disabled":
      return "Dream scheduling is currently disabled.";
    case "below_threshold":
      return pending ?? "The idle threshold has not been reached yet.";
    case "lock_busy":
      return "Dream is busy right now. Try again in a moment.";
    case "no-runner":
      return "The local runtime is not ready yet.";
    case "no-stella-root":
      return "Stella's workspace root is unavailable.";
    case "unavailable":
      return args.detail ?? "Dream is currently unavailable.";
    default:
      return args.detail ?? args.reason ?? pending;
  }
}

function ChronicleSettingsCard() {
  const chronicleApi = window.electronAPI?.chronicle;
  const { hasConnectedAccount } = useAuthSessionState();
  const [billingNowMs] = useState(() => Date.now());
  const billingStatus = useConvexOneShot(api.billing.getSubscriptionStatus, {
    now: billingNowMs,
  });
  // Chronicle ticks every minute against the user's captured screen
  // activity and runs through a Stella-provider model the user can't
  // override — locking it behind a paid plan keeps that cost on plans
  // that can absorb it.
  const requiresUpgrade =
    hasConnectedAccount &&
    billingStatus !== undefined &&
    billingStatus.plan === "free";
  const billingLoading =
    hasConnectedAccount && billingStatus === undefined;
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
        getSettingsErrorMessage(caught, "Failed to load Chronicle status."),
      );
    } finally {
      setLoading(false);
    }
  }, [chronicleApi]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    if (!chronicleApi?.setEnabled) return;
    if (next && !hasConnectedAccount) {
      const message = "Sign in to Stella before turning on screen memory.";
      setError(message);
      showToast({
        title: "Sign in required",
        description: message,
        variant: "error",
      });
      return;
    }
    if (next && requiresUpgrade) {
      const message =
        "Screen memory is included with any Stella plan. Upgrade to turn it on.";
      setError(message);
      showToast({
        title: "Subscription required",
        description: message,
        variant: "error",
        action: {
          label: "Upgrade",
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
        const message = formatChronicleEnableFailure(result);
        setError(message);
        showToast({
          title: next
            ? "Could not enable Chronicle"
            : "Could not disable Chronicle",
          description: message,
          variant: "error",
        });
      } else {
        showToast({
          title: next ? "Chronicle enabled" : "Chronicle disabled",
          description:
            result.reason === "already-running"
              ? "Chronicle was already running."
              : undefined,
          variant: "default",
        });
      }
      await refresh();
    } catch (caught) {
      setError(getSettingsErrorMessage(caught, "Failed to update Chronicle."));
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
      const description = formatDreamRunResult(result);
      showToast({
        title: result.ok ? "Dream pass scheduled" : "Dream pass not scheduled",
        description,
        variant: result.ok ? "success" : "error",
      });
    } catch (caught) {
      setError(
        getSettingsErrorMessage(caught, "Failed to trigger Dream pass."),
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
    const confirmed = window.confirm(
      "Erase everything Stella has remembered? This cannot be undone.",
    );
    if (!confirmed) return;
    setBusy("wipe");
    setError(null);
    try {
      const result = await chronicleApi.wipeMemories();
      if (!result.ok) {
        const message = result.reason ?? "Failed to wipe memories.";
        setError(message);
        showToast({
          title: "Wipe failed",
          description: message,
          variant: "error",
        });
        return;
      }
      showToast({
        title: "Memories wiped",
        variant: "success",
      });
      await refresh();
    } catch (caught) {
      setError(getSettingsErrorMessage(caught, "Failed to wipe memories."));
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

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Memory</h3>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Screen memory</div>
          <div className="settings-row-sublabel">
            {!hasConnectedAccount
              ? "Sign in to Stella before turning on screen memory."
              : requiresUpgrade
                ? "Screen memory is included with any Stella plan. Upgrade to turn it on."
                : "Lets Stella glance at your screen now and then so it can remember what you were doing."}
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn"
            disabled={busy !== null || loading || billingLoading}
            onClick={() => handleToggle(!enabled)}
          >
            {busy === "toggle"
              ? "Working…"
              : enabled
                ? "Disable"
                : !hasConnectedAccount
                  ? "Sign in to enable"
                  : requiresUpgrade
                    ? "Upgrade to enable"
                    : "Enable"}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Status</div>
          <div className="settings-row-sublabel">
            {loading
              ? "Loading…"
              : enabled
                ? `${running ? "Running" : "Stopped"}${
                    typeof fps === "number" ? ` · ${fps.toFixed(2)} fps` : ""
                  }${
                    lastCaptureAt
                      ? ` · last capture ${new Date(lastCaptureAt).toLocaleTimeString()}`
                      : ""
                  }`
                : "Disabled"}
          </div>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Memory folder</div>
          <div className="settings-row-sublabel">
            Open the folder on your computer where Stella keeps its memories.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn"
            disabled={busy !== null}
            onClick={handleOpenFolder}
          >
            {busy === "open" ? "Opening…" : "Open folder"}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Update memory now</div>
          <div className="settings-row-sublabel">
            Have Stella review recent activity and save what it learned. This
            usually happens on its own.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn"
            disabled={busy !== null}
            onClick={handleDreamNow}
          >
            {busy === "dream" ? "Dreaming…" : "Run now"}
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Erase memory</div>
          <div className="settings-row-sublabel">
            Delete everything Stella has remembered, including saved screen
            activity. This can't be undone.
          </div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="settings-btn settings-btn--danger"
            disabled={busy !== null}
            onClick={handleWipe}
          >
            {busy === "wipe" ? "Wiping…" : "Wipe"}
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
