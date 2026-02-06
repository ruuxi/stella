import { desktopCapturer } from 'electron';
type WindowInfo = {
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
/**
 * Pre-fetch desktop capturer sources before showing any overlay windows.
 * Call this while the screen is still clean, then pass the result to captureWindowAtPoint.
 * Pass excludeSourceIds to filter out known windows (e.g. the mini shell).
 */
export declare const prefetchWindowSources: (excludeSourceIds?: string[]) => Promise<DesktopSource[]>;
export declare const captureWindowAtPoint: (x: number, y: number, prefetchedSources?: DesktopSource[]) => Promise<WindowCapture | null>;
export {};
