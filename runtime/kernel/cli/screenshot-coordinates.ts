import fs from "node:fs";

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScreenshotInfo = {
  path?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
};

export type SnapshotLike = {
  windowFrame?: Rect | null;
  screenshot?: ScreenshotInfo | null;
  screenshotPath?: string | null;
};

export type ScreenPoint = {
  x: number;
  y: number;
};

type ScreenshotGeometry = {
  windowFrame: Rect;
  widthPx: number;
  heightPx: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isValidRect = (value: Rect | null | undefined): value is Rect =>
  !!value &&
  isFiniteNumber(value.x) &&
  isFiniteNumber(value.y) &&
  isFiniteNumber(value.width) &&
  isFiniteNumber(value.height) &&
  value.width > 0 &&
  value.height > 0;

const readPngDimensions = (filePath: string): { widthPx: number; heightPx: number } | null => {
  try {
    const data = fs.readFileSync(filePath);
    if (data.length < 24 || data.toString("ascii", 1, 4) !== "PNG") {
      return null;
    }
    const widthPx = data.readUInt32BE(16);
    const heightPx = data.readUInt32BE(20);
    if (widthPx <= 0 || heightPx <= 0) {
      return null;
    }
    return { widthPx, heightPx };
  } catch {
    return null;
  }
};

const resolveScreenshotGeometry = (
  snapshot: SnapshotLike | null,
): { geometry?: ScreenshotGeometry; error?: string } => {
  if (!snapshot) {
    return {
      error:
        "Screenshot-coordinate actions require an existing snapshot state. Run `stella-computer snapshot` first.",
    };
  }

  if (!isValidRect(snapshot.windowFrame)) {
    return {
      error:
        "The current snapshot is missing a valid `windowFrame`, so screenshot pixels cannot be mapped to screen coordinates. Take a fresh snapshot.",
    };
  }

  let widthPx = snapshot.screenshot?.widthPx ?? null;
  let heightPx = snapshot.screenshot?.heightPx ?? null;

  if (!isFiniteNumber(widthPx) || !isFiniteNumber(heightPx) || widthPx <= 0 || heightPx <= 0) {
    const screenshotPath = snapshot.screenshot?.path ?? snapshot.screenshotPath ?? null;
    if (screenshotPath) {
      const fileDimensions = readPngDimensions(screenshotPath);
      if (fileDimensions) {
        widthPx = fileDimensions.widthPx;
        heightPx = fileDimensions.heightPx;
      }
    }
  }

  if (!isFiniteNumber(widthPx) || !isFiniteNumber(heightPx) || widthPx <= 0 || heightPx <= 0) {
    return {
      error:
        "The current snapshot is missing screenshot dimensions. Take a fresh snapshot without `--no-screenshot`.",
    };
  }

  return {
    geometry: {
      windowFrame: snapshot.windowFrame,
      widthPx,
      heightPx,
    },
  };
};

export const screenshotPixelToScreenPoint = (
  snapshot: SnapshotLike | null,
  xPx: number,
  yPx: number,
): { point?: ScreenPoint; error?: string } => {
  if (!isFiniteNumber(xPx) || !isFiniteNumber(yPx)) {
    return {
      error: "Screenshot coordinates must be finite numbers.",
    };
  }

  const { geometry, error } = resolveScreenshotGeometry(snapshot);
  if (!geometry) {
    return { error };
  }

  if (xPx < 0 || xPx > geometry.widthPx || yPx < 0 || yPx > geometry.heightPx) {
    return {
      error:
        `Screenshot point (${xPx}, ${yPx}) is outside the captured image bounds ` +
        `(${geometry.widthPx}x${geometry.heightPx}).`,
    };
  }

  return {
    point: {
      x: geometry.windowFrame.x + (xPx / geometry.widthPx) * geometry.windowFrame.width,
      y: geometry.windowFrame.y + (yPx / geometry.heightPx) * geometry.windowFrame.height,
    },
  };
};
