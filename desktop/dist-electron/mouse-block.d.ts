/**
 * Mouse blocking helper for Windows
 * Spawns a standalone .exe that uses WH_MOUSE_LL to intercept Ctrl+Right-click
 * Communication via stdout - simpler than N-API addon, no node-gyp needed
 */
type MouseBlockEvent = 'down' | 'up';
type MouseBlockCallback = (event: MouseBlockEvent, x: number, y: number) => void;
/**
 * Start the mouse blocking helper
 * Returns true if started successfully
 */
export declare const startMouseBlock: (callback: MouseBlockCallback) => boolean;
/**
 * Stop the mouse blocking helper
 */
export declare const stopMouseBlock: () => boolean;
/**
 * Check if native blocking is available (helper exists)
 */
export declare const isNativeBlockingAvailable: () => boolean;
export {};
