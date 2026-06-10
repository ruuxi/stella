import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approximateDataUrlBytes,
  buildSpilledAttachmentNotice,
  INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES,
  spillImageAttachmentsToDisk,
} from "../../../../runtime/worker/chat-attachment-spill.js";

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const pngDataUrl = (payloadBytes: number): string => {
  const data = Buffer.concat([PNG_MAGIC, Buffer.alloc(payloadBytes, 0xab)]);
  return `data:image/png;base64,${data.toString("base64")}`;
};

describe("chat attachment spill", () => {
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-spill-test-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("approximates decoded bytes from a data URL", () => {
    const url = pngDataUrl(3000);
    const expected = PNG_MAGIC.length + 3000;
    // Padding chars count toward the estimate, so it may overshoot by ≤2.
    expect(approximateDataUrlBytes(url)).toBeGreaterThanOrEqual(expected);
    expect(approximateDataUrlBytes(url)).toBeLessThanOrEqual(expected + 2);
    expect(approximateDataUrlBytes("not a data url")).toBe(0);
  });

  it("keeps a typical single screenshot under the inline budget", () => {
    // ~8.6MB was the per-image size in the original 413 repro; one image
    // must stay inline (current behavior), ten must not.
    const single = 8.6 * 1024 * 1024;
    expect(single).toBeLessThan(INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES);
    expect(single * 10).toBeGreaterThan(INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES);
  });

  it("writes attachments to per-conversation files with mime-derived extensions", async () => {
    const spilled = await spillImageAttachmentsToDisk({
      stellaDataDirPath: dataDir,
      conversationId: "01ABC:DEF",
      attachments: [
        { url: pngDataUrl(64), mimeType: "image/png" },
        { url: pngDataUrl(128), mimeType: "image/jpeg" },
        // Non-data URLs are skipped (materialization upstream guarantees
        // data URLs, but the helper should not throw on stragglers).
        { url: "https://example.com/image.png", mimeType: "image/png" },
      ],
    });

    expect(spilled).toHaveLength(2);
    expect(spilled[0]?.filePath).toContain(
      path.join("cache", "chat-attachments", "01ABC-DEF"),
    );
    expect(spilled[0]?.filePath.endsWith(".png")).toBe(true);
    expect(spilled[1]?.filePath.endsWith(".jpg")).toBe(true);

    const first = await fs.readFile(spilled[0]!.filePath);
    expect(first.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(first.length).toBe(spilled[0]!.bytes);
  });

  it("builds a notice listing absolute paths and sizes", () => {
    const notice = buildSpilledAttachmentNotice([
      {
        filePath: "/tmp/a.png",
        mimeType: "image/png",
        bytes: 9 * 1024 * 1024,
      },
      { filePath: "/tmp/b.jpg", mimeType: "image/jpeg", bytes: 512 * 1024 },
    ]);
    expect(notice).toContain("2 images");
    expect(notice).toContain("1. /tmp/a.png (image/png, 9.0MB)");
    expect(notice).toContain("2. /tmp/b.jpg (image/jpeg, 0.5MB)");
    expect(notice).toContain("view_image");
  });
});
