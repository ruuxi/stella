/**
 * The shell radial dial's gesture driver: hold the right mouse button over
 * the full window, drag to a wedge, release to select.
 *
 * The dial is painted by the always-on-top overlay window (`radial:show`
 * with `variant: "shell"`), and this service owns one gesture at a time,
 * fed by two sources:
 *
 * - **The renderer (DOM source, permissionless).** A right-press that lands
 *   on ordinary shell DOM reaches the renderer's own pointer listeners; the
 *   bridge announces it over `shell-radial:dom-begin` and streams throttled
 *   move ticks and the release. This is the common case, and it needs no
 *   accessibility permission — a fresh install has a working dial.
 * - **The global input hook (uiohook, needs accessibility).** A right-press
 *   inside embedded content (artifact iframes, PDF/office viewers, webviews)
 *   never reaches the renderer; only the hook can see it. Hook presses ask
 *   the renderer whether the pressed point is exempt (`query-press`, failing
 *   OPEN after a deadline) because only the DOM knows what is under the
 *   cursor.
 *
 * The two sources feed one gesture, and every transition is idempotent, so
 * they cannot double-fire: for an ordinary-DOM press both fire, whichever
 * arrives first starts the gesture, and the other's begin collapses into a
 * claim (`dom-begin` while a hook press is querying) or a no-op. While a
 * gesture is live the hook — when running — also streams moves and the
 * release regardless of which source began it, which is what rescues a
 * DOM-begun drag that wanders into an embedded frame and loses its DOM
 * events.
 *
 * When the hook is NOT running, everything works except presses that begin
 * inside embedded content. Those are detected permissionlessly through the
 * webContents `context-menu` event (Chromium raises it for subframe and
 * webview presses the shell never sees) and surfaced to the renderer as
 * `shell-radial:swallowed-press`, which shows a one-time "grant
 * Accessibility so the dial also works over content" toast.
 *
 * Wedge indices are the shared quadrant order (0 at the upper-right,
 * clockwise): Home, Files, Close, Apps. `calculateSelectedWedgeIndex` is the
 * same function the chord dial commits through, and the overlay renderer
 * highlights through the same geometry, so highlight and commit agree.
 * Commit resolves from the physical cursor (`screen.getCursorScreenPoint`)
 * for both sources.
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
import { RADIAL_SIZE, SHELL_RADIAL_SCALE } from "../layout-constants.js";
import { calculateSelectedWedgeIndex } from "../radial-wedge.js";

const LEFT_MOUSE_BUTTON = 1;
/** libuiohook MOUSE_BUTTON2 — the right button on every platform it supports. */
const RIGHT_MOUSE_BUTTON = 2;
const ESCAPE_KEYCODE = 1;
const MOVE_THROTTLE_MS = 8;
/**
 * How long a hook press's exemption query may go unanswered before the dial
 * shows anyway. Failing OPEN is deliberate: the exempt case (composer,
 * editable fields) is the rare one, a wrongly-shown dial is recoverable with
 * a dead-zone release, and a silently-missing dial is not recoverable at
 * all — a busy or hung renderer must not eat the gesture.
 */
const QUERY_FAIL_OPEN_MS = 120;

type ShellRadialOverlayBridge = {
  showShellRadial: () => void;
  hideRadial: () => void;
  updateRadialCursor: () => void;
  getRadialBounds: () => { x: number; y: number } | null;
};

type ShellRadialGestureDeps = {
  getFullWindow: () => BrowserWindow | null;
  /** The chord dial's session; the two dials never run concurrently. */
  isSystemRadialActive: () => boolean;
  shouldEnable: () => boolean;
  /** Whether the global input hook is actually delivering events. */
  isHookRunning: () => boolean;
  overlay: ShellRadialOverlayBridge;
};

/**
 * `querying` — a hook press is waiting for the renderer's exemption answer;
 * no dial yet. `active` — the dial is up. DOM-begun gestures skip straight
 * to `active`: the renderer checked exemption before announcing the press.
 */
type GesturePhase = "querying" | "active";

export class ShellRadialGestureService {
  private readonly deps: ShellRadialGestureDeps;
  private started = false;
  private phase: GesturePhase | null = null;
  private queryToken = 0;
  private gestureWindow: BrowserWindow | null = null;
  private lastMoveAt = 0;
  private queryDeadline: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ShellRadialGestureDeps) {
    this.deps = deps;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // mousedown is attached for the service's lifetime (it is a rare event;
    // the mouse-hook does the same). mousemove — the hot one — is attached
    // only while a gesture is live, mirroring MouseHookManager's rule.
    uIOhook.on("mousedown", this.handleGlobalMousedown);
    uIOhook.on("mouseup", this.handleGlobalMouseup);
    ipcMain.on("shell-radial:press-response", this.handlePressResponse);
    ipcMain.on("shell-radial:dom-begin", this.handleDomBegin);
    ipcMain.on("shell-radial:dom-move", this.handleDomMove);
    ipcMain.on("shell-radial:dom-up", this.handleDomUp);
    ipcMain.on("shell-radial:dom-cancel", this.handleDomCancel);
    ipcMain.on("shell-radial:dom-leave", this.handleDomLeave);
    app.on("web-contents-created", this.handleWebContentsCreated);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.cancelGesture();
    uIOhook.off("mousedown", this.handleGlobalMousedown);
    uIOhook.off("mouseup", this.handleGlobalMouseup);
    ipcMain.removeListener(
      "shell-radial:press-response",
      this.handlePressResponse,
    );
    ipcMain.removeListener("shell-radial:dom-begin", this.handleDomBegin);
    ipcMain.removeListener("shell-radial:dom-move", this.handleDomMove);
    ipcMain.removeListener("shell-radial:dom-up", this.handleDomUp);
    ipcMain.removeListener("shell-radial:dom-cancel", this.handleDomCancel);
    ipcMain.removeListener("shell-radial:dom-leave", this.handleDomLeave);
    app.removeListener("web-contents-created", this.handleWebContentsCreated);
  }

  /** Whether `sender` is the full window this service acts for. */
  private senderIsFullWindow(sender: WebContents): BrowserWindow | null {
    const win = this.deps.getFullWindow();
    if (!win || win.isDestroyed() || sender !== win.webContents) return null;
    return win;
  }

  // ---- DOM source ---------------------------------------------------------

  private readonly handleDomBegin = (event: IpcMainEvent) => {
    const win = this.senderIsFullWindow(event.sender);
    if (!win) return;

    // A press over ordinary DOM is usually seen by BOTH sources. If the hook
    // got there first the gesture is mid-query; the renderer having received
    // the press IS the exemption answer (the bridge checks before sending),
    // so collapse the begin into a claim instead of double-starting.
    if (this.phase === "querying") {
      this.activateGesture();
      return;
    }
    if (this.phase !== null) return;
    if (this.deps.isSystemRadialActive()) return;

    this.beginGesture(win);
    this.activateGesture();
  };

  private readonly handleDomMove = (event: IpcMainEvent) => {
    if (!this.senderIsFullWindow(event.sender)) return;
    this.streamMove();
  };

  private readonly handleDomUp = (event: IpcMainEvent) => {
    if (!this.senderIsFullWindow(event.sender)) return;
    this.resolveGesture();
  };

  private readonly handleDomCancel = (event: IpcMainEvent) => {
    if (!this.senderIsFullWindow(event.sender)) return;
    this.cancelGesture();
  };

  private readonly handleDomLeave = (event: IpcMainEvent) => {
    if (!this.senderIsFullWindow(event.sender)) return;
    // Showing the transparent overlay BrowserWindow can make the renderer
    // report a leave while the physical cursor is still inside Stella.
    // Electron's screen coordinates are the source of truth.
    if (!this.cursorIsInsideGestureWindow()) this.cancelGesture();
  };

  // ---- Hook source --------------------------------------------------------

  private readonly handleGlobalMousedown = (event: UiohookMouseEvent) => {
    if (!this.started || this.phase !== null) return;
    if (event.button !== RIGHT_MOUSE_BUTTON) return;
    if (!this.deps.shouldEnable()) return;
    if (this.deps.isSystemRadialActive()) return;

    const win = this.deps.getFullWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) {
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return;

    // Only the renderer can see what is under the press — editable fields
    // and the composer keep their native context menu. The dial shows once
    // it answers (or a dom-begin for the same press arrives), or once the
    // fail-open deadline passes without an answer.
    this.beginGesture(win);
    this.queryToken += 1;
    this.queryDeadline = setTimeout(() => {
      this.queryDeadline = null;
      this.activateGesture();
    }, QUERY_FAIL_OPEN_MS);
    win.webContents.send("shell-radial:query-press", {
      x,
      y,
      token: this.queryToken,
    });
  };

  private readonly handlePressResponse = (
    event: IpcMainEvent,
    data: { token?: unknown; claim?: unknown },
  ) => {
    if (this.phase !== "querying") return;
    if (!this.senderIsFullWindow(event.sender)) return;
    if (data?.token !== this.queryToken) return;

    if (data.claim === false) {
      // An explicit decline (exempt target) is the only fail-closed path.
      this.cancelGesture();
      return;
    }

    this.activateGesture();
  };

  private readonly handleGlobalMousemove = () => {
    if (!this.cursorIsInsideGestureWindow()) {
      this.cancelGesture();
      return;
    }
    this.streamMove();
  };

  private readonly handleGlobalMouseup = (event: UiohookMouseEvent) => {
    if (this.phase === null) return;
    // The gesture is a right-button hold; a left release cannot end it.
    if (event.button === LEFT_MOUSE_BUTTON) return;

    if (this.phase === "querying") {
      // Released before the renderer answered — a fast click. The dial never
      // showed; there is nothing to commit.
      this.cancelGesture();
      return;
    }

    if (!this.cursorIsInsideGestureWindow()) {
      this.cancelGesture();
      return;
    }

    this.resolveGesture();
  };

  private readonly handleGlobalKeydown = (event: UiohookKeyboardEvent) => {
    if (event.keycode !== ESCAPE_KEYCODE) return;
    this.cancelGesture();
  };

  // ---- Swallowed-press detection (hook unavailable) -----------------------

  /**
   * A right-press inside an embedded frame raises the webContents
   * `context-menu` event even though the shell's document never hears the
   * press. With the hook running that press already opens the dial; without
   * it, this is exactly a press the dial silently lost — tell the renderer
   * so it can surface the missing permission once.
   */
  private readonly handleWebContentsCreated = (
    _event: unknown,
    contents: WebContents,
  ) => {
    contents.on("context-menu", (_menuEvent, params) => {
      if (!this.started) return;
      if (this.deps.isHookRunning()) return;
      if (this.phase !== null) return;
      if (params.isEditable) return;

      const win = this.deps.getFullWindow();
      if (!win || win.isDestroyed() || !win.isVisible()) return;

      const isFullWindowSubframe =
        contents === win.webContents &&
        params.frame != null &&
        params.frame !== win.webContents.mainFrame;
      const isEmbeddedGuest =
        contents.getType() === "webview" &&
        contents.hostWebContents === win.webContents;
      if (!isFullWindowSubframe && !isEmbeddedGuest) return;

      win.webContents.send("shell-radial:swallowed-press");
    });
  };

  // ---- Shared gesture state machine ---------------------------------------

  /** Claims the gesture slot and attaches everything both sources share. */
  private beginGesture(win: BrowserWindow) {
    this.phase = "querying";
    this.gestureWindow = win;
    win.on("blur", this.handleWindowBlur);
    // Attached for every gesture regardless of source: when the hook is
    // running it is the closer of last resort — a DOM-begun drag that enters
    // an embedded frame stops producing DOM events, but the hook still sees
    // the release. When the hook is not running these simply never fire.
    uIOhook.on("keydown", this.handleGlobalKeydown);
    uIOhook.on("mousemove", this.handleGlobalMousemove);
  }

  /** querying → active: show the dial and start streaming the highlight. */
  private activateGesture() {
    if (this.phase !== "querying") return;
    if (this.queryDeadline) {
      clearTimeout(this.queryDeadline);
      this.queryDeadline = null;
    }
    this.phase = "active";
    this.lastMoveAt = 0;
    this.deps.overlay.showShellRadial();
  }

  private streamMove() {
    if (this.phase !== "active") return;
    const now = Date.now();
    if (now - this.lastMoveAt < MOVE_THROTTLE_MS) return;
    this.lastMoveAt = now;
    this.deps.overlay.updateRadialCursor();
  }

  /** Commits the wedge under the physical cursor and ends the gesture. */
  private resolveGesture() {
    if (this.phase !== "active") return;
    const win = this.gestureWindow;
    const radialBounds = this.deps.overlay.getRadialBounds();
    this.teardownGesture();
    this.deps.overlay.hideRadial();

    if (!win || win.isDestroyed()) return;
    win.webContents.send("shell-radial:ended");
    if (!radialBounds) return;
    const cursor = screen.getCursorScreenPoint();
    const center = RADIAL_SIZE / 2;
    const index = calculateSelectedWedgeIndex(
      center + (cursor.x - radialBounds.x - center) / SHELL_RADIAL_SCALE,
      center + (cursor.y - radialBounds.y - center) / SHELL_RADIAL_SCALE,
      center,
      center,
    );
    // A dead-zone release dismisses without acting.
    if (index === null) return;
    win.webContents.send("shell-radial:commit", { index });
  }

  private readonly handleWindowBlur = () => {
    this.cancelGesture();
  };

  private cursorIsInsideGestureWindow(): boolean {
    const win = this.gestureWindow;
    if (!win || win.isDestroyed()) return false;
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    return (
      cursor.x >= bounds.x &&
      cursor.y >= bounds.y &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y <= bounds.y + bounds.height
    );
  }

  /** Ends the gesture without committing, hiding the dial if it was up. */
  private cancelGesture() {
    if (this.phase === null) return;
    const wasActive = this.phase === "active";
    const win = this.gestureWindow;
    this.teardownGesture();
    if (wasActive) this.deps.overlay.hideRadial();
    if (win && !win.isDestroyed()) {
      win.webContents.send("shell-radial:ended");
    }
  }

  /** Detaches per-gesture listeners and resets state. Never hides the dial. */
  private teardownGesture() {
    const win = this.gestureWindow;
    this.phase = null;
    this.gestureWindow = null;
    if (this.queryDeadline) {
      clearTimeout(this.queryDeadline);
      this.queryDeadline = null;
    }
    uIOhook.off("mousemove", this.handleGlobalMousemove);
    uIOhook.off("keydown", this.handleGlobalKeydown);
    if (win && !win.isDestroyed()) {
      win.removeListener("blur", this.handleWindowBlur);
    }
  }
}
