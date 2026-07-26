/**
 * Raises the shell's right-button radial dial for presses the renderer can
 * never see: right-clicks that land inside embedded frames — the sidebar's
 * artifact iframes (HTML canvases, office previews, PDFs) and webview
 * surfaces — where the press is delivered to the embedded document rather
 * than the shell's.
 *
 * Trigger: the `context-menu` webContents event. The shell's own document
 * suppresses that event for presses it handles itself (its window-level
 * `contextmenu` listener calls preventDefault), and lets it through for
 * exempt targets like the composer — so by the time it reaches us here, the
 * press is either inside a subframe of the full window or inside a webview
 * guest embedded in it. Anything else is left alone.
 *
 * Once the dial is open the same problem repeats for the rest of the
 * gesture: the frame that owns the press keeps receiving the drag, so the
 * shell would never hear the move stream or the committing release. While a
 * frame-initiated gesture is live we forward global mouse moves, the
 * right-button release, and Escape from uIOhook — attached only for the
 * duration of the gesture, mirroring the mouse-hook's own perf rule that
 * `mousemove` must never be subscribed while idle. The hook itself is
 * started (or not, without accessibility permission) by MouseHookManager;
 * if it is not delivering, the dial still opens and Escape in the renderer
 * still cancels, because the press handler re-focuses the shell document.
 *
 * The same OS-level closer also backs renderer-initiated gestures: the shell
 * announces every DOM-begun gesture over `shell-radial:track`, because DOM
 * delivery of the release is best-effort — a drag that enters an embedded
 * frame hands real-input routing to that frame's widget, and a release inside
 * a `-webkit-app-region: drag` strip is consumed by window-dragging before
 * the page sees it. The hook's release is authoritative; whichever of the DOM
 * or hook release arrives first resolves the gesture and the other no-ops.
 *
 * The frame-press trigger is macOS-only: `context-menu` fires at right-press
 * time there, which is what a press-drag-release gesture needs. On
 * Windows/Linux the event fires at release — too late to start a hold
 * gesture — so those keep DOM-only press coverage (release tracking still
 * applies).
 */

import {
  app,
  ipcMain,
  screen,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import {
  uIOhook,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
} from "uiohook-napi";

const LEFT_MOUSE_BUTTON = 1;
const ESCAPE_KEYCODE = 1;
const MOVE_THROTTLE_MS = 8;

type ShellRadialFramePressDeps = {
  getFullWindow: () => BrowserWindow | null;
};

export class ShellRadialFramePressService {
  private readonly deps: ShellRadialFramePressDeps;
  private started = false;
  private tracking = false;
  private trackedWindow: BrowserWindow | null = null;
  private lastMoveAt = 0;

  constructor(deps: ShellRadialFramePressDeps) {
    this.deps = deps;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // The frame-press trigger is macOS-only (context-menu fires at press time
    // there); OS-level release tracking for renderer-initiated gestures is
    // wanted everywhere the hook runs.
    if (process.platform === "darwin") {
      app.on("web-contents-created", this.handleWebContentsCreated);
    }
    ipcMain.on("shell-radial:track", this.handleTrackRequest);
    ipcMain.on("shell-radial:untrack", this.handleUntrackRequest);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.endTracking(false);
    app.removeListener("web-contents-created", this.handleWebContentsCreated);
    ipcMain.removeListener("shell-radial:track", this.handleTrackRequest);
    ipcMain.removeListener("shell-radial:untrack", this.handleUntrackRequest);
  }

  /**
   * A DOM-initiated gesture just began in the shell. DOM delivery of its
   * release is not guaranteed — embedded frames own real-input routing once
   * the drag enters them, and window drag regions swallow events entirely —
   * so the OS-level hook watches the release for these gestures too.
   */
  private readonly handleTrackRequest = (event: IpcMainEvent) => {
    const win = this.deps.getFullWindow();
    if (!win || win.isDestroyed()) return;
    if (event.sender !== win.webContents) return;
    this.beginTracking(win);
  };

  private readonly handleUntrackRequest = (event: IpcMainEvent) => {
    const win = this.deps.getFullWindow();
    if (win && !win.isDestroyed() && event.sender !== win.webContents) return;
    this.endTracking(false);
  };

  private readonly handleWebContentsCreated = (
    _event: unknown,
    contents: WebContents,
  ) => {
    contents.on("context-menu", (event, params) => {
      if (!this.started) return;
      const win = this.deps.getFullWindow();
      if (!win || win.isDestroyed() || !win.isVisible()) return;

      // Editable fields keep native context-menu semantics even inside
      // embedded content — same rule the renderer applies to its own inputs.
      if (params.isEditable) return;

      const isFullWindowSubframe =
        contents === win.webContents &&
        params.frame != null &&
        params.frame !== win.webContents.mainFrame;
      const isEmbeddedGuest =
        contents.getType() === "webview" &&
        contents.hostWebContents === win.webContents;
      if (!isFullWindowSubframe && !isEmbeddedGuest) return;

      // Subframe params are already in the top view's client space; a webview
      // guest's are relative to the guest, whose element offset this process
      // does not know — for those the physical cursor position stands in.
      const point = isFullWindowSubframe
        ? { x: params.x, y: params.y }
        : this.cursorInWindow(win);
      if (!point) return;

      event.preventDefault();
      win.webContents.send("shell-radial:press", point);
      this.beginTracking(win);
    });
  };

  /** Cursor position in the window's content (client) space, or null if outside. */
  private cursorInWindow(win: BrowserWindow): { x: number; y: number } | null {
    const point = this.cursorRelativeTo(win);
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x > win.getContentBounds().width ||
      point.y > win.getContentBounds().height
    ) {
      return null;
    }
    return point;
  }

  /**
   * Cursor in client space without bounds clamping. Moves are allowed to
   * leave the window — past its dead zone the dial is an infinite pie, and a
   * flick can legitimately end outside the window entirely.
   */
  private cursorRelativeTo(win: BrowserWindow): { x: number; y: number } {
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    return { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  }

  private beginTracking(win: BrowserWindow) {
    if (this.tracking) this.endTracking(false);
    this.tracking = true;
    this.trackedWindow = win;
    this.lastMoveAt = 0;
    uIOhook.on("mousemove", this.handleGlobalMove);
    uIOhook.on("mouseup", this.handleGlobalUp);
    uIOhook.on("keydown", this.handleGlobalKeydown);
    win.on("blur", this.handleTrackedWindowBlur);
  }

  private endTracking(sendCancel: boolean) {
    if (!this.tracking) return;
    this.tracking = false;
    const win = this.trackedWindow;
    this.trackedWindow = null;
    uIOhook.off("mousemove", this.handleGlobalMove);
    uIOhook.off("mouseup", this.handleGlobalUp);
    uIOhook.off("keydown", this.handleGlobalKeydown);
    if (win && !win.isDestroyed()) {
      win.removeListener("blur", this.handleTrackedWindowBlur);
      if (sendCancel) win.webContents.send("shell-radial:cancel");
    }
  }

  private readonly handleGlobalMove = (_event: UiohookMouseEvent) => {
    const win = this.trackedWindow;
    if (!win || win.isDestroyed()) {
      this.endTracking(false);
      return;
    }
    const now = Date.now();
    if (now - this.lastMoveAt < MOVE_THROTTLE_MS) return;
    this.lastMoveAt = now;
    win.webContents.send("shell-radial:move", this.cursorRelativeTo(win));
  };

  private readonly handleGlobalUp = (event: UiohookMouseEvent) => {
    // The gesture is a right-button hold; a left release mid-gesture is not
    // its end (and cannot be — the left button was never down).
    if (event.button === LEFT_MOUSE_BUTTON) return;
    const win = this.trackedWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send("shell-radial:up", this.cursorRelativeTo(win));
    }
    this.endTracking(false);
  };

  private readonly handleGlobalKeydown = (event: UiohookKeyboardEvent) => {
    if (event.keycode !== ESCAPE_KEYCODE) return;
    this.endTracking(true);
  };

  private readonly handleTrackedWindowBlur = () => {
    this.endTracking(true);
  };
}
