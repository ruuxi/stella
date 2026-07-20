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
  const validPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  it("reuses the terminal image_gen artifact when the sidebar materializer completes", async () => {
    const dataDir = tempDirs.create("media-output-dedupe-");
    const outputDir = path.join(dataDir, "media", "outputs");
    const outputPath = path.join(outputDir, "job-1_0.png");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, validPng);
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
          url: `data:image/png;base64,${validPng.toString("base64")}`,
          fileName: "job-1_0.png",
        },
      ),
    ).resolves.toEqual({ ok: true, path: outputPath });
    expect(fs.readFileSync(outputPath)).toEqual(validPng);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not publish a corrupt renderer image artifact", async () => {
    const dataDir = tempDirs.create("media-output-corrupt-");
    registerBrowserHandlers({
      getStellaAppDir: () => dataDir,
      getStellaDataDir: () => dataDir,
      assertPrivilegedSender: () => true,
    });
    const handler = handlers.get(IPC_MEDIA_SAVE_OUTPUT)!;
    const result = await handler(
      {},
      {
        url: `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`,
        fileName: "corrupt_0.png",
      },
    );
    expect(result).toMatchObject({ ok: false });
    expect(
      fs.existsSync(path.join(dataDir, "media", "outputs", "corrupt_0.png")),
    ).toBe(false);
  });
});
