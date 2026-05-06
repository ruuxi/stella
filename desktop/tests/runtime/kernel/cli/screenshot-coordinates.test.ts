import path from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { screenshotPixelToScreenPoint } from "../../../../../runtime/kernel/cli/screenshot-coordinates.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const createTempDir = () => {
  return tempDirs.create("stella-screenshot-coords-");
};

const writeFakePngHeader = (
  filePath: string,
  widthPx: number,
  heightPx: number,
) => {
  const data = Buffer.alloc(24);
  data.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(widthPx, 16);
  data.writeUInt32BE(heightPx, 20);
  writeFileSync(filePath, data);
};

describe("screenshotPixelToScreenPoint", () => {
  it("maps screenshot pixels into the captured window frame", () => {
    const result = screenshotPixelToScreenPoint(
      {
        windowFrame: { x: 100, y: 200, width: 600, height: 300 },
        screenshot: { widthPx: 1200, heightPx: 600, path: null },
      },
      300,
      150,
    );

    expect(result.error).toBeUndefined();
    expect(result.point).toEqual({ x: 250, y: 275 });
  });

  it("falls back to the saved PNG dimensions when metadata is missing", () => {
    const tempDir = createTempDir();
    const screenshotPath = path.join(tempDir, "snapshot.png");
    writeFakePngHeader(screenshotPath, 400, 200);

    const result = screenshotPixelToScreenPoint(
      {
        windowFrame: { x: 10, y: 20, width: 100, height: 50 },
        screenshot: { path: screenshotPath, widthPx: null, heightPx: null },
        screenshotPath,
      },
      200,
      100,
    );

    expect(result.error).toBeUndefined();
    expect(result.point?.x).toBeCloseTo(60);
    expect(result.point?.y).toBeCloseTo(45);
  });

  it("returns a clear error when screenshot geometry is unavailable", () => {
    const result = screenshotPixelToScreenPoint(
      {
        windowFrame: { x: 10, y: 20, width: 100, height: 50 },
        screenshot: null,
        screenshotPath: null,
      },
      10,
      10,
    );

    expect(result.point).toBeUndefined();
    expect(result.error).toContain(
      "Take a fresh snapshot without `--no-screenshot`",
    );
  });
});
