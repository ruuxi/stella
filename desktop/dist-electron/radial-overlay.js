import { screen } from 'electron';
export const RADIAL_SIZE = 280;
let overlayWindow = null;
let radialBounds = null;
let radialScaleFactor = 1;
let radialVisible = false;
export const setRadialOverlayWindow = (window) => {
    overlayWindow = window;
};
export const showRadialOverlay = (x, y, meta) => {
    if (!overlayWindow)
        return;
    radialVisible = true;
    const cursorPoint = { x, y };
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const scaleFactor = display.scaleFactor ?? 1;
    radialScaleFactor = scaleFactor;
    const adjustedX = Math.round(x / scaleFactor - RADIAL_SIZE / 2);
    const adjustedY = Math.round(y / scaleFactor - RADIAL_SIZE / 2);
    radialBounds = { x: adjustedX, y: adjustedY };
    const overlayBounds = overlayWindow.getBounds();
    const dialX = adjustedX - overlayBounds.x;
    const dialY = adjustedY - overlayBounds.y;
    const relativeX = x / scaleFactor - adjustedX;
    const relativeY = y / scaleFactor - adjustedY;
    overlayWindow.webContents.send('radial:show', {
        x: relativeX,
        y: relativeY,
        centerX: RADIAL_SIZE / 2,
        centerY: RADIAL_SIZE / 2,
        dialX,
        dialY,
        requestId: meta?.requestId,
        sentAt: meta?.sentAt,
    });
    overlayWindow.webContents.send('radial:animate');
};
export const hideRadialOverlay = () => {
    if (!overlayWindow)
        return;
    radialVisible = false;
    radialBounds = null;
    overlayWindow.webContents.send('radial:hide');
};
export const updateRadialOverlayCursor = (x, y) => {
    if (!overlayWindow || !radialVisible || !radialBounds)
        return;
    const relativeX = x / radialScaleFactor - radialBounds.x;
    const relativeY = y / radialScaleFactor - radialBounds.y;
    overlayWindow.webContents.send('radial:cursor', {
        x: relativeX,
        y: relativeY,
        centerX: RADIAL_SIZE / 2,
        centerY: RADIAL_SIZE / 2,
    });
};
export const getRadialOverlayMetrics = () => {
    if (!radialBounds)
        return null;
    return { bounds: radialBounds, scaleFactor: radialScaleFactor };
};
