import { useCallback, useEffect, useMemo, useState } from "react";
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

  return {
    installManifest,
    currentRelease: currentRelease ?? null,
    installedCommit,
    publishedCommit,
    updateAvailable,
    refreshManifest,
  };
};
