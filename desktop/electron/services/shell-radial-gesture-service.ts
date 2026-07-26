/**
 * The shell radial dial's gesture driver: hold the right mouse button over
 * the full window, drag to a wedge, release to select.
 *
 * Architecturally this is the system chord dial, retriggered: the dial is
 * painted by the always-on-top overlay window (`radial:show` with
 * `variant: "shell"`), the gesture is captured globally by uiohook, and the
 * selection is committed here in the main process from the release position.
 * Nothing about the gesture depends on DOM event delivery in the shell —
 * which is the whole point. The previous in-renderer implementation lost
 * releases to embedded frames (which own real-input routing once a press or
 * drag involves them) and to `-webkit-app-region: drag` strips (which consume
 * events before the page sees them); an overlay window driven by the global
 * hook receives no DOM events and so has nothing to lose.
 *
 * The renderer keeps two small jobs. It answers `shell-radial:query-press`
 * with whether the pressed point is exempt (editable fields and the composer
 * keep their native context menu — only the renderer can see what is under
 * the cursor), and it applies the committed wedge from `shell-radial:commit`
 * (sections go through `sidebarSections.selectSection`; the Close wedge
 * closes the panel).
 *
 * Wedge indices are the shared quadrant order (0 at the upper-right,
 * clockwise): Home, Files, Close, Apps. `calculateSelectedWedgeIndex` is the
 * same function the chord dial commits through, and the overlay renderer
 * highlights through the same geometry, so highlight and commit agree.
 *
 * Like the chord dial, this requires the uiohook to be running (accessibility
 * permission); without it right-press simply does nothing and the app behaves
 * as if the feature is absent.
 */

import {
  ipcMain,
  screen,
  type BrowserWindow,
  type IpcMainEvent,
} from "electron";
import {
  uIOhook,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
} from "uiohook-napi";
import { RADIAL_SIZE } from "../layout-constants.js";
import { calculateSelectedWedgeIndex } from "../radial-wedge.js";

const LEFT_MOUSE_BUTTON = 1;
const RIGHT_MOUSE_BUTTON = 2;
const ESCAPE_KEYCODE = 1;
const MOVE_THROTTLE_MS = 8;

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
  overlay: ShellRadialOverlayBridge;
};

/**
 * `querying` — right button is down and the renderer has been asked whether
 * the pressed target is exempt; no dial yet. `active` — the dial is up.
 */
type GesturePhase = "querying" | "active";

export class ShellRadialGestureService {
  private readonly deps: ShellRadialGestureDeps;
  private started = false;
  private phase: GesturePhase | null = null;
  private queryToken = 0;
  private gestureWindow: BrowserWindow | null = null;
  private lastMoveAt = 0;

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
  }

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

    // The renderer is the only side that can see what is under the press:
    // editable fields and the composer keep their native context menu, so
    // the dial must not claim those. The dial shows only once it answers.
    this.phase = "querying";
    this.gestureWindow = win;
    this.queryToken += 1;
    win.on("blur", this.handleWindowBlur);
    uIOhook.on("keydown", this.handleGlobalKeydown);
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
    const win = this.gestureWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (data?.token !== this.queryToken) return;

    if (data.claim !== true) {
      this.cancelGesture();
      return;
    }

    this.phase = "active";
    this.lastMoveAt = 0;
    uIOhook.on("mousemove", this.handleGlobalMousemove);
    this.deps.overlay.showShellRadial();
  };

  private readonly handleGlobalMousemove = () => {
    if (this.phase !== "active") return;
    const now = Date.now();
    if (now - this.lastMoveAt < MOVE_THROTTLE_MS) return;
    this.lastMoveAt = now;
    this.deps.overlay.updateRadialCursor();
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

    const win = this.gestureWindow;
    const radialBounds = this.deps.overlay.getRadialBounds();
    this.teardownGesture();
    this.deps.overlay.hideRadial();

    if (!win || win.isDestroyed() || !radialBounds) return;
    const cursor = screen.getCursorScreenPoint();
    const index = calculateSelectedWedgeIndex(
      cursor.x - radialBounds.x,
      cursor.y - radialBounds.y,
      RADIAL_SIZE / 2,
      RADIAL_SIZE / 2,
    );
    // A dead-zone release dismisses without acting.
    if (index === null) return;
    win.webContents.send("shell-radial:commit", { index });
  };

  private readonly handleGlobalKeydown = (event: UiohookKeyboardEvent) => {
    if (event.keycode !== ESCAPE_KEYCODE) return;
    this.cancelGesture();
  };

  private readonly handleWindowBlur = () => {
    this.cancelGesture();
  };

  /** Ends the gesture without committing, hiding the dial if it was up. */
  private cancelGesture() {
    if (this.phase === null) return;
    const wasActive = this.phase === "active";
    this.teardownGesture();
    if (wasActive) this.deps.overlay.hideRadial();
  }

  /** Detaches per-gesture listeners and resets state. Never hides the dial. */
  private teardownGesture() {
    const win = this.gestureWindow;
    this.phase = null;
    this.gestureWindow = null;
    uIOhook.off("mousemove", this.handleGlobalMousemove);
    uIOhook.off("keydown", this.handleGlobalKeydown);
    if (win && !win.isDestroyed()) {
      win.removeListener("blur", this.handleWindowBlur);
    }
  }
}
