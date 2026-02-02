import { BrowserWindow, screen } from 'electron';
let overlayWindow = null;
/**
 * Create a transparent fullscreen overlay that captures right-clicks
 * when the modifier key is held. This prevents native context menus.
 */
export const createModifierOverlay = () => {
    if (overlayWindow)
        return;
    // Get primary display for initial sizing
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.bounds;
    overlayWindow = new BrowserWindow({
        width,
        height,
        x: 0,
        y: 0,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        focusable: true, // Need focusable to capture right-clicks on Windows
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    // Make it click-through by default
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    // Prevent the window from being closed
    overlayWindow.on('close', (e) => {
        e.preventDefault();
        overlayWindow?.hide();
    });
    // Load with minimal opacity and context menu prevention
    // rgba(0,0,0,0.01) is invisible to the eye but makes Windows treat it as a real window
    overlayWindow.loadURL(`data:text/html,<html style="background:rgba(0,0,0,0.01)">
    <body oncontextmenu="return false" style="margin:0;width:100vw;height:100vh"></body>
  </html>`);
};
/**
 * Show the overlay and make it capture right-clicks
 */
export const showModifierOverlay = () => {
    if (!overlayWindow)
        return;
    // Cover all displays
    const displays = screen.getAllDisplays();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const display of displays) {
        const { x, y, width, height } = display.bounds;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
    }
    overlayWindow.setBounds({
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    });
    // Capture right-clicks (but let left-clicks through)
    overlayWindow.setIgnoreMouseEvents(false);
    overlayWindow.showInactive();
};
/**
 * Hide the overlay and make it click-through again
 */
export const hideModifierOverlay = () => {
    if (!overlayWindow)
        return;
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.hide();
};
/**
 * Cleanup on app quit
 */
export const destroyModifierOverlay = () => {
    if (overlayWindow) {
        overlayWindow.removeAllListeners('close');
        overlayWindow.destroy();
        overlayWindow = null;
    }
};
