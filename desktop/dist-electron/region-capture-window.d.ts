import { BrowserWindow } from 'electron';
export declare const createRegionCaptureWindow: () => BrowserWindow;
export declare const showRegionCaptureWindow: (cancelCallback?: () => void) => Promise<void>;
export declare const hideRegionCaptureWindow: () => void;
export declare const getRegionCaptureWindow: () => BrowserWindow | null;
