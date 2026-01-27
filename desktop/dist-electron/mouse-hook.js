import { uIOhook } from 'uiohook-napi';
const HOLD_THRESHOLD_MS = 100;
const RIGHT_BUTTON = 2;
export class MouseHookManager {
    constructor(events) {
        this.rightDownTime = null;
        this.rightDownPosition = null;
        this.radialActive = false;
        this.holdTimer = null;
        this.started = false;
        this.events = events;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        uIOhook.on('mousedown', (event) => {
            if (event.button === RIGHT_BUTTON) {
                this.rightDownTime = Date.now();
                this.rightDownPosition = { x: event.x, y: event.y };
                // Start timer for hold detection
                this.holdTimer = setTimeout(() => {
                    if (this.rightDownPosition) {
                        this.radialActive = true;
                        this.events.onRadialShow(this.rightDownPosition.x, this.rightDownPosition.y);
                    }
                }, HOLD_THRESHOLD_MS);
            }
        });
        uIOhook.on('mouseup', (event) => {
            if (event.button === RIGHT_BUTTON) {
                const wasHeld = this.radialActive;
                // Clear hold timer
                if (this.holdTimer) {
                    clearTimeout(this.holdTimer);
                    this.holdTimer = null;
                }
                if (wasHeld) {
                    // Radial was shown, trigger selection
                    this.events.onMouseUp(event.x, event.y);
                    this.events.onRadialHide();
                }
                else {
                    // Short click - pass through to native menu
                    if (this.rightDownPosition) {
                        this.events.onNativeMenuRequest(this.rightDownPosition.x, this.rightDownPosition.y);
                    }
                }
                this.radialActive = false;
                this.rightDownTime = null;
                this.rightDownPosition = null;
            }
        });
        uIOhook.on('mousemove', (event) => {
            if (this.radialActive) {
                this.events.onMouseMove(event.x, event.y);
            }
        });
        uIOhook.start();
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        if (this.holdTimer) {
            clearTimeout(this.holdTimer);
            this.holdTimer = null;
        }
        uIOhook.stop();
    }
    isRadialActive() {
        return this.radialActive;
    }
}
