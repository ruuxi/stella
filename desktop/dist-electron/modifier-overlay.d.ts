/**
 * Create a transparent fullscreen overlay that captures right-clicks
 * when the modifier key is held. This prevents native context menus.
 */
export declare const createModifierOverlay: () => void;
/**
 * Show the overlay preemptively on macOS when the modifier key is pressed.
 * This positions the overlay before a right-click can fire so that macOS
 * delivers the context-menu event to the overlay (which suppresses it)
 * instead of to the app underneath.
 */
export declare const showModifierOverlayPreemptive: () => void;
/**
 * Show the overlay and make it capture right-clicks
 */
export declare const showModifierOverlay: () => void;
/**
 * Hide the overlay and make it click-through again
 */
export declare const hideModifierOverlay: () => void;
/**
 * Cleanup on app quit
 */
export declare const destroyModifierOverlay: () => void;
