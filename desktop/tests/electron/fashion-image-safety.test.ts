import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn() },
}));

import {
  prepareFashionImage,
  stashTryOnImagePaths,
} from "../../electron/ipc/fashion-handlers.js";
import { decodeAndValidateImage } from "../../../runtime/kernel/tools/image-decode-validation.js";
import { readAuthorizedImageReference } from "../../../runtime/kernel/tools/image-reference-policy.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("Fashion image safety", () => {
  it.runIf(process.platform === "darwin")(
    "converts a production-shaped HEIC Fashion reference to a decoded JPEG",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "stella-fashion-heic-"),
      );
      roots.add(root);
      const sourcePng = path.join(root, "picked.png");
      const sourceHeic = path.join(root, "picked.heic");
      fs.writeFileSync(
        sourcePng,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      execFileSync("/usr/bin/sips", [
        "-s",
        "format",
        "heic",
        sourcePng,
        "--out",
        sourceHeic,
      ]);

      const prepared = await prepareFashionImage(
        sourceHeic,
        path.join(root, "fashion"),
      );
      expect(prepared.ext).toBe("jpg");
      expect(await decodeAndValidateImage(prepared.bytes)).toMatchObject({
        mimeType: "image/jpeg",
      });

      const [stashed] = await stashTryOnImagePaths(root, "tryon-production", [
        sourceHeic,
      ]);
      expect(stashed).toMatch(/fashion\/try-on\/tryon-production\/0\.jpg$/);
      await expect(
        readAuthorizedImageReference(stashed!, {
          conversationId: "fashion-test",
          requestId: "fashion-tool",
          runId: "fashion-run",
          rootRunId: "fashion-run",
          agentType: "fashion",
          stellaAppDir: root,
          stellaDataDir: root,
          storageMode: "local",
        }),
      ).resolves.toMatchObject({ mimeType: "image/jpeg" });
    },
  );
});
