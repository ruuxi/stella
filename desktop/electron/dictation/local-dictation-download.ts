import type { LocalParakeetStatus } from "./local-parakeet.js";

export type LocalDictationDownloadDependencies = {
  getStellaInstallDir: () => string | null;
  getStatus: () => Promise<LocalParakeetStatus>;
  refreshNativeHelpers: (stellaInstallDir: string) => Promise<unknown>;
  downloadModel: () => Promise<LocalParakeetStatus>;
};

/**
 * Creates the on-demand local-dictation installer. Concurrent clicks share a
 * single operation so the native-helper bundle and model are never downloaded
 * twice in parallel.
 */
export const createLocalDictationDownloader = (
  dependencies: LocalDictationDownloadDependencies,
) => {
  let inFlight: Promise<LocalParakeetStatus> | null = null;

  return (): Promise<LocalParakeetStatus> => {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const initialStatus = await dependencies.getStatus();
      if (!initialStatus.available) {
        const stellaInstallDir = dependencies.getStellaInstallDir();
        if (!stellaInstallDir) {
          throw new Error("Stella's install directory is unavailable.");
        }
        await dependencies.refreshNativeHelpers(stellaInstallDir);
      }

      const ready = await dependencies.downloadModel();
      if (!ready.available) {
        throw new Error(
          ready.reason ?? "The local dictation model is unavailable.",
        );
      }
      return ready;
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };
};
