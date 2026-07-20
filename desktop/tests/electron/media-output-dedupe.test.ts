import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerBrowserHandlers } from "../../electron/ipc/browser-handlers.js";
import { IPC_MEDIA_SAVE_OUTPUT } from "../../src/shared/contracts/ipc-channels.js";
import { createSyncTempDirTracker } from "../helpers/temp.js";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, payload: unknown) => Promise<unknown>
  >(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: unknown, payload: unknown) => Promise<unknown>,
      ) => {
        handlers.set(channel, handler);
      },
    ),
  },
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
}));

const tempDirs = createSyncTempDirTracker();

afterEach(() => {
  handlers.clear();
  tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("media output artifact dedupe", () => {
  it("reuses the terminal image_gen artifact when the sidebar materializer completes", async () => {
    const dataDir = tempDirs.create("media-output-dedupe-");
    const outputDir = path.join(dataDir, "media", "outputs");
    const outputPath = path.join(outputDir, "job-1_0.png");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from("terminal-artifact"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("sidebar must not redownload"));

    registerBrowserHandlers({
      getStellaAppDir: () => dataDir,
      getStellaDataDir: () => dataDir,
      assertPrivilegedSender: () => true,
    });
    const handler = handlers.get(IPC_MEDIA_SAVE_OUTPUT);
    expect(handler).toBeDefined();

    await expect(
      handler!(
        {},
        {
          url: "data:image/png;base64,c2lkZWJhci1kdXBsaWNhdGU=",
          fileName: "job-1_0.png",
        },
      ),
    ).resolves.toEqual({ ok: true, path: outputPath });
    expect(fs.readFileSync(outputPath, "utf8")).toBe("terminal-artifact");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
