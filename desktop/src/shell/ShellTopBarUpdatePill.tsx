import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Download, RefreshCw, X } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { useDesktopUpdate } from "@/global/updates/use-desktop-update";
import {
  applyDesktopUpdate,
  cancelActiveDesktopUpdate,
  getActiveDesktopUpdate,
  subscribeActiveDesktopUpdate,
} from "@/global/updates/apply-desktop-update";
import "./shell-topbar-update-pill.css";

/**
 * Compact "update available" pill that lives in the shell top bar,
 * right of the macOS traffic-light controls. Mirrors the apply/cancel
 * flow that previously lived in the Settings banner. Clean merges apply
 * directly; conflict cases fall back to a background install-update agent.
 */
/**
 * Quiet awareness of a deferred runtime-worker restart: the host detected
 * new runtime code (self-mod apply / update) while work was in flight and
 * will restart the worker when it goes quiescent. Sourced from the
 * `runtime:availability` broadcasts.
 */
const usePendingRuntimeRestart = (): boolean => {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const unsubscribe = window.electronAPI?.agent?.onAvailability?.(
      (snapshot) => {
        setPending(snapshot.pendingRuntimeRestart === true);
      },
    );
    return () => {
      unsubscribe?.();
    };
  }, []);
  return pending;
};

export const ShellTopBarUpdatePill = () => {
  const isMiniWindow = useWindowType() === "mini";
  const pendingRuntimeRestart = usePendingRuntimeRestart();
  const {
    installManifest,
    currentRelease,
    publishedCommit,
    updateAvailable,
    refreshManifest,
  } = useDesktopUpdate();
  const activeUpdate = useSyncExternalStore(
    subscribeActiveDesktopUpdate,
    getActiveDesktopUpdate,
    getActiveDesktopUpdate,
  );
  const updateState = activeUpdate?.status ?? "idle";
  const canCancel = Boolean(activeUpdate?.runId);

  const handleUpdate = useCallback(async () => {
    if (!installManifest || !currentRelease || !publishedCommit) return;
    if (updateState !== "idle") return;
    try {
      const result = await applyDesktopUpdate({
        installManifest,
        publishedCommit,
        publishedTag: currentRelease.tag,
        publishedAt: currentRelease.publishedAt,
        ...(currentRelease.artifactRefs
          ? { artifactRefs: currentRelease.artifactRefs }
          : {}),
        onAppliedCommit: refreshManifest,
        onFinished: (event) => {
          if (event.outcome !== "completed") {
            showToast({
              title:
                event.outcome === "canceled"
                  ? "Update cancelled"
                  : "Update didn't finish",
              description:
                event.outcome === "canceled"
                  ? "Stella stopped applying the update."
                  : (event.reason ?? event.error ?? "Please try again."),
              variant: "error",
            });
          }
        },
      });
      if (result) {
        if (result.mode === "auto") {
          if (result.reloaded === false) {
            // The update landed on disk but the running app couldn't be
            // reloaded onto it (e.g. the runtime restarted mid-update).
            // Don't claim success — the code on screen is still the old one.
            showToast({
              title: "Update installed — restart to finish",
              description: `Stella downloaded ${currentRelease.tag}, but couldn't hot-reload onto it. Restart Stella (or click Update again) to finish.`,
              variant: "error",
            });
          } else {
            showToast({
              title: "Update applied",
              description: `Stella updated to ${currentRelease.tag}.`,
            });
          }
        } else {
          showToast({
            title: "Stella is updating",
            description: "Stella is applying the update in the background.",
          });
        }
      }
    } catch (error) {
      const message = (error as Error).message ?? "Please try again.";
      const timedOut = /timed out/i.test(message);
      showToast({
        title: timedOut ? "Update timed out" : "Couldn't start update",
        description: message,
        variant: "error",
      });
    }
  }, [
    installManifest,
    currentRelease,
    publishedCommit,
    refreshManifest,
    updateState,
  ]);

  const handleCancel = useCallback(() => {
    if (!cancelActiveDesktopUpdate()) {
      showToast({
        title: "Update is still starting",
        description: "Cancel will be available once Stella begins applying it.",
        variant: "error",
      });
      return;
    }
    showToast({
      title: "Canceling update",
      description: "Stella is stopping the update thread.",
    });
  }, []);

  if (isMiniWindow) return null;
  if (!updateAvailable || !currentRelease) {
    // No desktop update to offer, but a runtime restart may be queued behind
    // in-flight work — show a quiet, non-interactive note so the deferral is
    // never silent.
    if (pendingRuntimeRestart) {
      return (
        <div
          className="shell-topbar-update-pill"
          data-state="pending-runtime"
          title="Runtime update pending — applies when current work finishes"
        >
          <span className="shell-topbar-update-pill__main shell-topbar-update-pill__main--passive">
            <RefreshCw
              className="shell-topbar-update-pill__icon"
              size={12}
              strokeWidth={2}
              aria-hidden
            />
            <span className="shell-topbar-update-pill__label">
              Runtime update pending
            </span>
          </span>
        </div>
      );
    }
    return null;
  }
  if (activeUpdate?.status === "background") return null;

  const isActive = updateState !== "idle";
  const label =
    updateState === "starting"
      ? "Starting…"
      : updateState === "running"
        ? "Updating…"
        : "Update";

  return (
    <div
      className="shell-topbar-update-pill"
      data-state={isActive ? "active" : "idle"}
    >
      <button
        type="button"
        className="shell-topbar-update-pill__main"
        onClick={() => void handleUpdate()}
        disabled={isActive}
        aria-label={isActive ? label : "Update Stella"}
        title={
          isActive
            ? label
            : currentRelease
              ? `Update Stella to ${currentRelease.tag}`
              : "Update Stella (no update published — visible for testing)"
        }
      >
        <Download
          className="shell-topbar-update-pill__icon"
          size={12}
          strokeWidth={2}
          aria-hidden
        />
        <span className="shell-topbar-update-pill__label">{label}</span>
      </button>
      {isActive ? (
        <button
          type="button"
          className="shell-topbar-update-pill__cancel"
          onClick={() => void handleCancel()}
          disabled={!canCancel}
          aria-label="Cancel update"
          title="Cancel update"
        >
          <X size={11} strokeWidth={2.25} aria-hidden />
        </button>
      ) : null}
    </div>
  );
};
