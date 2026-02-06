/**
 * Initialize persistent PowerShell process at app startup
 * This loads UI Automation assemblies once and keeps them in memory
 */
export declare const initSelectedTextProcess: () => void;
/**
 * Cleanup persistent PowerShell process on app quit
 */
export declare const cleanupSelectedTextProcess: () => void;
/**
 * Get currently selected text using platform-native APIs (Windows/macOS only)
 */
export declare const getSelectedText: () => Promise<string | null>;
