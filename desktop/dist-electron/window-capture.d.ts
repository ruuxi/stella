import { desktopCapturer } from 'electron';
export type WindowInfo = {
    title: string;
    process: string;
    pid: number;
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
};
type WindowCapture = {
    windowInfo: WindowInfo;
    screenshot: {
        dataUrl: string;
        width: number;
        height: number;
    };
};
type DesktopSource = Awaited<ReturnType<typeof desktopCapturer.getSources>>[number];
type QueryWindowInfoOptions = {
    excludePids?: number[];
};
export declare const getWindowInfoAtPoint: (x: number, y: number, options?: QueryWindowInfoOptions) => Promise<WindowInfo | null>;
/**
 * Pre-fetch desktop capturer sources before showing any overlay windows.
 * Call this while the screen is still clean, then pass the result to captureWindowAtPoint.
 * Pass excludeSourceIds to filter out known windows (e.g. the mini shell).
 */
export declare const prefetchWindowSources: (excludeSourceIds?: string[]) => Promise<DesktopSource[]>;
export declare const captureWindowAtPoint: (x: number, y: number, prefetchedSources?: DesktopSource[], options?: QueryWindowInfoOptions) => Promise<WindowCapture | null>;
/**
 * Capture a window screenshot using the native binary's --screenshot flag.
 * Returns window info + base64 PNG data URL, or null on failure.
 * This avoids desktopCapturer.getSources() entirely (~15ms vs 100-500ms).
 */
export declare const captureWindowScreenshot: (x: number, y: number, options?: QueryWindowInfoOptions) => Promise<WindowCapture | null>;
export {};
