import { uIOhook } from 'uiohook-napi';
import { startMouseBlock, stopMouseBlock, isNativeBlockingAvailable } from './mouse-block.js';
const LEFT_BUTTON = 1;
const RIGHT_BUTTON = 2;
// Key codes for Ctrl and Cmd
const KEY_CTRL_LEFT = 29;
const KEY_CTRL_RIGHT = 3613;
const KEY_META_LEFT = 3675; // Left Cmd on macOS
const KEY_META_RIGHT = 3676; // Right Cmd on macOS
export class MouseHookManager {
    constructor(events) {
        this.radialActive = false;
        this.started = false;
        this.modifierHeld = false;
        this.useNativeBlocking = false;
        this.events = events;
    }
    isModifierKey(keycode) {
        // Ctrl on Windows/Linux, Cmd on macOS
        if (process.platform === 'darwin') {
            return keycode === KEY_META_LEFT || keycode === KEY_META_RIGHT;
        }
        return keycode === KEY_CTRL_LEFT || keycode === KEY_CTRL_RIGHT;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        // Try to use native blocking on Windows (blocks context menu completely)
        if (process.platform === 'win32' && isNativeBlockingAvailable()) {
            this.useNativeBlocking = startMouseBlock((event, x, y) => {
                if (event === 'down') {
                    this.radialActive = true;
                    this.events.onRadialShow(x, y);
                }
                else if (event === 'up') {
                    if (this.radialActive) {
                        this.events.onMouseUp(x, y);
                        this.events.onRadialHide();
                        this.radialActive = false;
                    }
                }
            });
            if (this.useNativeBlocking) {
                console.log('[mouse-hook] Using native blocking for Ctrl+right-click');
            }
        }
        // Track modifier key state (always needed)
        uIOhook.on('keydown', (event) => {
            if (this.isModifierKey(event.keycode) && !this.modifierHeld) {
                this.modifierHeld = true;
                this.events.onModifierDown();
            }
        });
        uIOhook.on('keyup', (event) => {
            if (this.isModifierKey(event.keycode)) {
                this.modifierHeld = false;
                this.events.onModifierUp();
                // If radial is active and modifier released, cancel it
                if (this.radialActive) {
                    this.events.onRadialHide();
                    this.radialActive = false;
                }
            }
        });
        // Only use uiohook for mouse events if native blocking isn't available
        if (!this.useNativeBlocking) {
            uIOhook.on('mousedown', (event) => {
                // Only trigger on Ctrl+right-click (Cmd+right-click on macOS)
                if (event.button === RIGHT_BUTTON && this.modifierHeld) {
                    this.radialActive = true;
                    this.events.onRadialShow(event.x, event.y);
                }
            });
            uIOhook.on('mouseup', (event) => {
                if (event.button === RIGHT_BUTTON && this.radialActive) {
                    this.events.onMouseUp(event.x, event.y);
                    this.events.onRadialHide();
                    this.radialActive = false;
                }
            });
        }
        // Mouse move tracking (always use uiohook for this)
        uIOhook.on('mousemove', (event) => {
            if (this.radialActive) {
                this.events.onMouseMove(event.x, event.y);
            }
        });
        // Global left-click tracking (for dismissing popups like mini shell)
        uIOhook.on('mousedown', (event) => {
            if (event.button === LEFT_BUTTON && this.events.onLeftClick) {
                this.events.onLeftClick(event.x, event.y);
            }
        });
        uIOhook.start();
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        if (this.useNativeBlocking) {
            stopMouseBlock();
        }
        uIOhook.stop();
    }
    isRadialActive() {
        return this.radialActive;
    }
}
