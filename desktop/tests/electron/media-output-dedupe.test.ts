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
  vi.unstubAllGlobals();
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
        // Destination extension is intentionally non-image: detected source
        // bytes, not the requested suffix, must select image validation.
        fileName: "corrupt_0.bin",
      },
    );
    expect(result).toMatchObject({ ok: false });
    expect(
      fs.existsSync(path.join(dataDir, "media", "outputs", "corrupt_0.bin")),
    ).toBe(false);

    const mismatch = await handler(
      {},
      {
        url: `data:image/png;base64,${validPng.toString("base64")}`,
        fileName: "misleading_0.jpg",
      },
    );
    expect(mismatch).toMatchObject({ ok: false });
    expect(
      fs.existsSync(path.join(dataDir, "media", "outputs", "misleading_0.jpg")),
    ).toBe(false);
  });

  it("validates remote image bytes independently of URL suffix and content type", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const dataDir = tempDirs.create("media-output-remote-validation-");
    try {
      registerBrowserHandlers({
        getStellaAppDir: () => dataDir,
        getStellaDataDir: () => dataDir,
        assertPrivilegedSender: () => true,
      });
      const handler = handlers.get(IPC_MEDIA_SAVE_OUTPUT)!;
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = String(input);
        if (url === "https://example.test/corrupt.bin") {
          return new Response(Buffer.from("not an image"), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (url === "https://example.test/generated.bin") {
          return new Response(validPng, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        throw new Error(`Unexpected fetch ${url}`);
      }));
      await expect(
        handler(
          {},
          {
            url: "https://example.test/corrupt.bin",
            fileName: "remote-corrupt.bin",
            kind: "image",
          },
        ),
      ).resolves.toMatchObject({ ok: false });
      expect(
        fs.existsSync(
          path.join(dataDir, "media", "outputs", "remote-corrupt.bin"),
        ),
      ).toBe(false);
      const valid = await handler(
        {},
        {
          url: "https://example.test/generated.bin",
          fileName: "remote-valid.bin",
          kind: "image",
        },
      );
      const normalizedPath = path.join(
        dataDir,
        "media",
        "outputs",
        "remote-valid.png",
      );
      expect(valid).toEqual({ ok: true, path: normalizedPath });
      expect(fs.readFileSync(normalizedPath)).toEqual(validPng);
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });
});
