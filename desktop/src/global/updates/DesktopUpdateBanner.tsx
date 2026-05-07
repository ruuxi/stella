import { useCallback, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { useDesktopUpdate } from "./use-desktop-update";
import { applyDesktopUpdate } from "./apply-desktop-update";
import "./desktop-update-banner.css";

/**
 * Persistent "update available" banner.
 *
 * Per `AGENTS.md` we never auto-apply: the banner notifies and waits for
 * an explicit click. Spawning the agent is fire-and-forget; once the
 * thread exists the user can navigate into it via the conversations
 * list to watch progress.
 */
export const DesktopUpdateBanner = () => {
  const {
    installManifest,
    currentRelease,
    publishedCommit,
    installedCommit,
    updateAvailable,
    refreshManifest,
  } = useDesktopUpdate();
  const [updateState, setUpdateState] = useState<
    "idle" | "starting" | "running"
  >("idle");
  const [cancelUpdate, setCancelUpdate] = useState<(() => boolean) | null>(
    null,
  );

  const handleUpdate = useCallback(async () => {
    if (!installManifest || !currentRelease || !publishedCommit) return;
    if (updateState !== "idle") return;
    setUpdateState("starting");
    setCancelUpdate(null);
    let finished = false;
    try {
      const result = await applyDesktopUpdate({
        installManifest,
        publishedCommit,
        publishedTag: currentRelease.tag,
        publishedAt: currentRelease.publishedAt,
        onAppliedCommit: refreshManifest,
        onFinished: (event) => {
          finished = true;
          setUpdateState("idle");
          setCancelUpdate(null);
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
        if (!finished) {
          setCancelUpdate(() => result.cancel);
          setUpdateState("running");
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
      setUpdateState("idle");
      setCancelUpdate(null);
    }
  }, [
    installManifest,
    currentRelease,
    publishedCommit,
    refreshManifest,
    updateState,
  ]);

  const handleCancel = useCallback(() => {
    if (!cancelUpdate) return;
    if (!cancelUpdate()) {
      showToast({
        title: "Update is still starting",
        description: "Cancel will be available once Stella begins applying it.",
        variant: "error",
      });
      return;
    }
    setCancelUpdate(null);
    showToast({
      title: "Canceling update",
      description: "Stella is stopping the update thread.",
    });
  }, [cancelUpdate]);

  if (!updateAvailable || !currentRelease) return null;

  const shortCurrent = publishedCommit?.slice(0, 7) ?? "";
  const shortInstalled = installedCommit?.slice(0, 7) ?? "";

  return (
    <div className="desktop-update-banner">
      <div className="desktop-update-banner__body">
        <Download size={16} aria-hidden />
        <div className="desktop-update-banner__copy">
          <div className="desktop-update-banner__title">
            New Stella release available
          </div>
          <div className="desktop-update-banner__detail">
            {currentRelease.tag} ({shortCurrent}) — installed {shortInstalled}
          </div>
        </div>
      </div>
      <div className="desktop-update-banner__actions">
        {updateState === "running" ? (
          <Button
            variant="secondary"
            size="small"
            onClick={() => void handleCancel()}
            disabled={!cancelUpdate}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="small"
          onClick={() => void handleUpdate()}
          disabled={updateState !== "idle"}
        >
          {updateState === "starting"
            ? "Starting..."
            : updateState === "running"
              ? "Updating..."
              : "Update Stella"}
        </Button>
      </div>
    </div>
  );
};
