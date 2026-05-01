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
  } = useDesktopUpdate();
  const [busy, setBusy] = useState(false);

  const handleUpdate = useCallback(async () => {
    if (!installManifest || !currentRelease || !publishedCommit) return;
    setBusy(true);
    try {
      const result = await applyDesktopUpdate({
        installManifest,
        publishedCommit,
        publishedTag: currentRelease.tag,
        publishedAt: currentRelease.publishedAt,
      });
      if (result) {
        showToast({
          title: "Update started",
          description:
            "Stella is applying the new release in a dedicated agent thread.",
        });
      }
    } catch (error) {
      showToast({
        title: "Couldn't start update",
        description: (error as Error).message ?? "Please try again.",
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [installManifest, currentRelease, publishedCommit]);

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
      <Button
        variant="primary"
        size="small"
        onClick={() => void handleUpdate()}
        disabled={busy}
      >
        {busy ? "Starting…" : "Update Stella"}
      </Button>
    </div>
  );
};
