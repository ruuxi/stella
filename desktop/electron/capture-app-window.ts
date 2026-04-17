import { desktopCapturer } from "electron";
import { captureWindowScreenshotByPid } from "./window-capture.js";

/**
 * Snapshot of an app's topmost window: a PNG data URL plus the window
 * title we found. Returned by `captureAppWindow` for the auto-context chip
 * "lazy capture" path — we attach the chip eagerly with metadata, then
 * patch in this screenshot when it lands.
 */
export type AppWindowCapture = {
  title: string;
  screenshot: {
    dataUrl: string;
    width: number;
    height: number;
  };
};

const MAX_THUMBNAIL_DIM = 1280;

const normalizeName = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, "").trim();

type CaptureOptions = {
  /** Preferred selector — pid uniquely identifies the running app. */
  pid?: number | null;
  /** Fallback selector — only used when pid is missing or fails. */
  appName?: string | null;
};

/**
 * Captures the topmost on-screen window for the given app.
 *
 * macOS: when a `pid` is provided, uses the bundled `window_info --pid=<pid>`
 * native helper, which performs ScreenCaptureKit window capture against
 * the topmost matching window. This is the reliable path — Electron's
 * `desktopCapturer.getSources({ types: ['window'] })` returns sources with
 * names that don't include the app prefix on modern macOS, so a
 * name-based match against window sources misses most apps.
 *
 * When no pid is provided (or the native helper fails) we fall back to
 * `desktopCapturer` and a name match — useful for cmd+rc → "Open chat"
 * which doesn't have a pid and for non-macOS platforms.
 */
export const captureAppWindow = async (
  options: CaptureOptions,
): Promise<AppWindowCapture | null> => {
  const pid =
    typeof options.pid === "number" && Number.isFinite(options.pid) && options.pid > 0
      ? options.pid
      : null;

  if (pid !== null && process.platform === "darwin") {
    try {
      const capture = await captureWindowScreenshotByPid(pid);
      if (capture) {
        return {
          title: capture.windowInfo.title ?? "",
          screenshot: capture.screenshot,
        };
      }
    } catch (error) {
      console.warn("[home] captureWindowScreenshotByPid failed", error);
    }
  }

  const appName = (options.appName ?? "").trim();
  if (!appName) return null;
  return await captureAppWindowByName(appName);
};

/**
 * Fallback path — match a window source by app name via `desktopCapturer`.
 * On modern macOS most window sources are named after the window title,
 * not "<App> - <Title>", so this only succeeds for a small set of apps.
 * Kept around for cmd+rc → "Open chat" which doesn't carry a pid, and
 * eventually for Windows/Linux capture.
 */
const captureAppWindowByName = async (
  appName: string,
): Promise<AppWindowCapture | null> => {
  const targetNormalized = normalizeName(appName);

  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: MAX_THUMBNAIL_DIM, height: MAX_THUMBNAIL_DIM },
      fetchWindowIcons: false,
    });
  } catch (error) {
    console.warn("[home] captureAppWindow getSources failed", error);
    return null;
  }

  const candidates = sources
    .map((source) => {
      const sourceName = source.name ?? "";
      const trimmedName = sourceName.trim();
      if (!trimmedName) return null;

      const splitMatch = trimmedName.match(/^(.+?)\s+[\u2013\u2014-]\s+(.*)$/);
      const appPortion = splitMatch ? splitMatch[1] : trimmedName;
      const titlePortion = splitMatch ? splitMatch[2] : "";
      const appPortionNormalized = normalizeName(appPortion);

      let score = 0;
      if (appPortionNormalized === targetNormalized) {
        score = 3;
      } else if (appPortionNormalized.startsWith(targetNormalized)) {
        score = 2;
      } else if (appPortionNormalized.includes(targetNormalized)) {
        score = 1;
      } else {
        return null;
      }

      return { source, score, titlePortion };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== null,
    )
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;

  const best = candidates[0];
  const thumbnail = best.source.thumbnail;
  if (thumbnail.isEmpty()) return null;
  const size = thumbnail.getSize();

  return {
    title: best.titlePortion,
    screenshot: {
      dataUrl: thumbnail.toDataURL(),
      width: size.width,
      height: size.height,
    },
  };
};
