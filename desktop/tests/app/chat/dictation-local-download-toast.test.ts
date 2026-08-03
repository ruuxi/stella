// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dismissToast: vi.fn(),
  setLocalDictationPreference: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/ui/toast", () => ({
  dismissToast: mocks.dismissToast,
  showToast: mocks.showToast,
}));

vi.mock("@/features/dictation/services/inworld-dictation", () => ({
  setLocalDictationPreference: mocks.setLocalDictationPreference,
}));

import {
  DOWNLOAD_LOCAL_DICTATION_ACTION,
  startLocalDictationDownload,
} from "@/features/dictation/services/local-dictation-download";

const setDictationApi = (
  downloadLocalModel: () => Promise<{
    available: boolean;
    model: string;
    reason?: string;
  }>,
) => {
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: {
      dictation: { downloadLocalModel },
    },
  });
};

describe("local dictation download toast", () => {
  beforeEach(() => {
    mocks.dismissToast.mockReset();
    mocks.setLocalDictationPreference.mockReset();
    mocks.showToast.mockReset();
    mocks.showToast.mockReturnValue("loading-toast");
  });

  it("shows background progress and confirms when dictation is ready", async () => {
    setDictationApi(async () => ({
      available: true,
      model: "parakeet-tdt-0.6b-v3-coreml",
    }));

    await startLocalDictationDownload();

    expect(DOWNLOAD_LOCAL_DICTATION_ACTION.label).toBe(
      "Download voice feature",
    );
    expect(mocks.setLocalDictationPreference).toHaveBeenCalledWith(true);
    expect(mocks.showToast).toHaveBeenNthCalledWith(1, {
      title: "Downloading voice feature",
      description:
        "The download is continuing in the background. You can keep using Stella.",
      variant: "loading",
      duration: 0,
    });
    expect(mocks.dismissToast).toHaveBeenCalledWith("loading-toast");
    expect(mocks.showToast).toHaveBeenNthCalledWith(2, {
      title: "Voice feature is ready",
      description: "On-device dictation is ready to use.",
      variant: "success",
      duration: 6000,
    });
  });

  it("replaces background progress with a retry toast on failure", async () => {
    setDictationApi(async () => {
      throw new Error("network unavailable");
    });

    await startLocalDictationDownload();

    expect(mocks.dismissToast).toHaveBeenCalledWith("loading-toast");
    expect(mocks.showToast).toHaveBeenLastCalledWith({
      title: "Voice feature couldn't be downloaded",
      description: "Check your connection and try downloading it again.",
      variant: "error",
      duration: 8000,
      action: DOWNLOAD_LOCAL_DICTATION_ACTION,
    });
  });
});
