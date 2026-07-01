import path from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readImageFileSettled } from "../../../../../runtime/kernel/shared/read-image-file.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();
afterEach(() => tempDirs.cleanup());

// 1x1 transparent PNG (smallest valid PNG bytes) — includes the IEND chunk,
// so it is structurally complete.
const COMPLETE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);
// Same PNG with the trailing IEND chunk lopped off: the signature + IHDR
// still parse, but the stream is truncated — exactly what a reader that opens
// a screenshot mid-write sees.
const TRUNCATED_PNG = COMPLETE_PNG.subarray(0, COMPLETE_PNG.length - 16);

describe("readImageFileSettled", () => {
  it("returns a fully written image on the first read with no waiting", async () => {
    const dir = tempDirs.create("settle-complete-");
    const imgPath = path.join(dir, "snap.png");
    writeFileSync(imgPath, COMPLETE_PNG);

    let sleeps = 0;
    const buf = await readImageFileSettled(imgPath, {
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(buf.equals(COMPLETE_PNG)).toBe(true);
    expect(sleeps).toBe(0);
  });

  it("re-reads until a screenshot still flushing to disk becomes complete", async () => {
    const dir = tempDirs.create("settle-race-");
    const imgPath = path.join(dir, "snap.png");
    // Reader wins the race: only the truncated prefix is on disk.
    writeFileSync(imgPath, TRUNCATED_PNG);

    let sleeps = 0;
    const buf = await readImageFileSettled(imgPath, {
      // While the guard backs off, the writer finishes flushing the file.
      sleep: async () => {
        sleeps += 1;
        writeFileSync(imgPath, COMPLETE_PNG);
      },
    });

    expect(buf.equals(COMPLETE_PNG)).toBe(true);
    expect(sleeps).toBe(1);
  });

  it("stops early (does not spin the budget) when the file is truncated on disk", async () => {
    const dir = tempDirs.create("settle-corrupt-");
    const imgPath = path.join(dir, "snap.png");
    writeFileSync(imgPath, TRUNCATED_PNG);

    let sleeps = 0;
    const buf = await readImageFileSettled(imgPath, {
      maxAttempts: 6,
      // File never grows between reads -> genuinely truncated, not mid-write.
      sleep: async () => {
        sleeps += 1;
      },
    });

    // Returns the (incomplete) bytes so the caller's validation can drop it,
    // but bails after the file proves stable instead of burning all attempts.
    expect(buf.equals(TRUNCATED_PNG)).toBe(true);
    expect(sleeps).toBe(1);
  });
});
