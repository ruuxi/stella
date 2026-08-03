import { describe, expect, it, vi } from "vitest";
import { createLocalDictationDownloader } from "../../electron/dictation/local-dictation-download.js";

const available = {
  available: true,
  model: "parakeet-tdt-0.6b-v3-coreml",
} as const;

describe("local dictation downloader", () => {
  it("downloads missing native helpers before warming the model", async () => {
    const refreshNativeHelpers = vi.fn(async () => undefined);
    const downloadModel = vi.fn(async () => available);
    const download = createLocalDictationDownloader({
      getStellaInstallDir: () => "/tmp/stella-install",
      getStatus: async () => ({
        ...available,
        available: false,
        reason: "Local Parakeet helper has not been built.",
      }),
      refreshNativeHelpers,
      downloadModel,
    });

    await expect(download()).resolves.toEqual(available);
    expect(refreshNativeHelpers).toHaveBeenCalledOnce();
    expect(refreshNativeHelpers).toHaveBeenCalledWith("/tmp/stella-install");
    expect(downloadModel).toHaveBeenCalledOnce();
  });

  it("skips the helper refresh when the helper is already available", async () => {
    const refreshNativeHelpers = vi.fn(async () => undefined);
    const downloadModel = vi.fn(async () => available);
    const download = createLocalDictationDownloader({
      getStellaInstallDir: () => "/tmp/stella-install",
      getStatus: async () => available,
      refreshNativeHelpers,
      downloadModel,
    });

    await expect(download()).resolves.toEqual(available);
    expect(refreshNativeHelpers).not.toHaveBeenCalled();
    expect(downloadModel).toHaveBeenCalledOnce();
  });

  it("shares concurrent download requests", async () => {
    let finish: ((status: typeof available) => void) | null = null;
    const downloadModel = vi.fn(
      () =>
        new Promise<typeof available>((resolve) => {
          finish = resolve;
        }),
    );
    const download = createLocalDictationDownloader({
      getStellaInstallDir: () => "/tmp/stella-install",
      getStatus: async () => available,
      refreshNativeHelpers: async () => undefined,
      downloadModel,
    });

    const first = download();
    const second = download();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(downloadModel).toHaveBeenCalledOnce();

    finish?.(available);
    await expect(first).resolves.toEqual(available);
  });
});
