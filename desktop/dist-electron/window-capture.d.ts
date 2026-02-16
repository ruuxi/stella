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
type QueryWindowInfoOptions = {
    excludePids?: number[];
};
export declare const getWindowInfoAtPoint: (x: number, y: number, options?: QueryWindowInfoOptions) => Promise<WindowInfo | null>;
/**
 * Capture a window screenshot using the native binary's --screenshot flag.
 * Returns window info + base64 PNG data URL, or null on failure.
 * Uses PrintWindow (Windows) / CGWindowListCreateImage (macOS) to capture
 * a single window directly — no desktopCapturer enumeration needed (~15ms vs 100-500ms).
 */
export declare const captureWindowScreenshot: (x: number, y: number, options?: QueryWindowInfoOptions) => Promise<WindowCapture | null>;
export {};
