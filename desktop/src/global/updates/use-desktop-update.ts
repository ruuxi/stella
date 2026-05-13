import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import type { InstallManifestSnapshot } from "@/shared/types/electron";

/**
 * Reactive desktop-update awareness.
 *
 * - `installManifest` is the parsed `stella-install.json` written by the
 *   launcher (contains `desktopReleaseCommit` — the upstream GitHub SHA
 *   the tarball was built from).
 * - `currentRelease` is the latest published release for this platform,
 *   pushed reactively over Convex by the CI publish job.
 * - `updateAvailable` is true when the published commit differs from the
 *   commit that's installed locally.
 *
 * The hook is intentionally read-only — applying the update spawns an
 * `install_update` agent thread (see `applyDesktopUpdate.ts`).
 */

const platformKeyForCurrentEnv = (
  electronPlatform: string,
  arch: string,
): string => {
  if (electronPlatform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (electronPlatform === "win32") {
    return "win-x64";
  }
  return "linux-x64";
};

const detectPlatformKey = (): string => {
  // `electronAPI.platform` and `electronAPI.arch` are forwarded from
  // `process.platform` / `process.arch` by the preload script — the
  // authoritative source. UA sniffing for "ARM" was guesswork; if it
  // returned the wrong key the install would silently report no
  // updates available because the Convex `currentDesktopRelease` query
  // is keyed by exact platform.
  const electronApi =
    (typeof window !== "undefined" ? window.electronAPI : null) ?? null;
  const electronPlatform = electronApi?.platform ?? "darwin";
  const arch = electronApi?.arch ?? "x64";
  return platformKeyForCurrentEnv(electronPlatform, arch);
};

type DesktopUpdateState = {
  installManifest: InstallManifestSnapshot | null;
  currentRelease: {
    platform: string;
    tag: string;
    commit: string;
    archiveUrl: string;
    archiveSha256: string;
    archiveSize: number;
    publishedAt: number;
  } | null;
  installedCommit: string | null;
  publishedCommit: string | null;
  updateAvailable: boolean;
  refreshManifest: () => Promise<void>;
};

export const useDesktopUpdate = (): DesktopUpdateState => {
  const platform = useMemo(() => detectPlatformKey(), []);
  const [installManifest, setInstallManifest] =
    useState<InstallManifestSnapshot | null>(null);

  const refreshManifest = useCallback(async () => {
    const electronApi = window.electronAPI;
    if (!electronApi?.updates?.getInstallManifest) {
      setInstallManifest(null);
      return;
    }
    try {
      const next = await electronApi.updates.getInstallManifest();
      setInstallManifest(next);
    } catch {
      setInstallManifest(null);
    }
  }, []);

  useEffect(() => {
    void refreshManifest();
  }, [refreshManifest]);

  const currentRelease = useQuery(
    api.data.desktop_releases.currentDesktopRelease,
    { platform },
  );

  const installedCommit = installManifest?.desktopReleaseCommit ?? null;
  const publishedCommit = currentRelease?.commit ?? null;
  const updateAvailable = Boolean(
    publishedCommit && installedCommit && publishedCommit !== installedCommit,
  );

  // If the install-update agent restarted Electron before the renderer's
  // run-finished handler could record the applied commit, the manifest is
  // left stale on next launch and the pill keeps nagging. Reconcile by
  // asking the main process to record the published commit — the IPC
  // handler verifies HEAD is at/past that commit via
  // `git merge-base --is-ancestor` and throws otherwise, so this is a
  // no-op when the merge really didn't land.
  const reconcileAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!updateAvailable || !publishedCommit || !currentRelease) return;
    if (reconcileAttemptedFor.current === publishedCommit) return;
    reconcileAttemptedFor.current = publishedCommit;
    const electronApi = window.electronAPI;
    const recordAppliedCommit = electronApi?.updates?.recordAppliedCommit;
    if (!recordAppliedCommit) return;
    void (async () => {
      try {
        const manifest = await recordAppliedCommit(
          publishedCommit,
          currentRelease.tag,
        );
        setInstallManifest(manifest);
      } catch {
        // Expected when HEAD really isn't at the target yet — leave the
        // pill visible so the user can apply the update normally.
      }
    })();
  }, [updateAvailable, publishedCommit, currentRelease]);

  return {
    installManifest,
    currentRelease: currentRelease ?? null,
    installedCommit,
    publishedCommit,
    updateAvailable,
    refreshManifest,
  };
};
