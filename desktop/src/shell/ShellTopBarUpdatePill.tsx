import { useCallback, useSyncExternalStore } from "react";
import { X } from "lucide-react";
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
 * flow that previously lived in the Settings banner — clicking the
 * pill spawns the install-update agent (never auto-applies, per
 * `AGENTS.md`), and the inline `×` cancels the in-flight run.
 */
export const ShellTopBarUpdatePill = () => {
  const isMiniWindow = useWindowType() === "mini";
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
        onAppliedCommit: refreshManifest,
        onFinished: (event) => {
          if (event.outcome !== "completed") {
            showToast({
              title:
                event.outcome === "canceled"
                  ? "Update canceled"
                  : "Update didn't finish",
              description:
                event.outcome === "canceled"
                  ? "No changes were recorded."
                  : (event.reason ?? event.error ?? "Please try again."),
              variant: "error",
            });
          }
        },
      });
      if (result) {
        const active = getActiveDesktopUpdate();
        if (active?.conversationId === result.conversationId) {
          showToast({
            title: "Update started",
            description:
              "Stella is applying the new release in a dedicated agent thread.",
          });
        }
      }
    } catch (error) {
      showToast({
        title: "Couldn't start update",
        description: (error as Error).message ?? "Please try again.",
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
  if (!updateAvailable || !currentRelease) return null;

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
