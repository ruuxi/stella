/**
 * The shell radial dial's main-process gesture driver, exercised without an
 * app: uiohook and electron are mocked, and the tests drive the exact event
 * sequences real gestures produce — from both sources. The regressions this
 * guards against present as a silent no-op (wrong button constant, missing
 * registration, fail-closed exemption query) or as double-fired gestures
 * when the DOM and hook sources see the same press.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookEmitter = new EventEmitter();
const appEmitter = new EventEmitter();
const ipcListeners = new Map<string, (...args: never[]) => void>();
const cursor = { x: 0, y: 0 };

vi.mock("uiohook-napi", () => ({
  uIOhook: {
    on: (event: string, fn: (...args: never[]) => void) => {
      hookEmitter.on(event, fn as (...args: unknown[]) => void);
    },
    off: (event: string, fn: (...args: never[]) => void) => {
      hookEmitter.off(event, fn as (...args: unknown[]) => void);
    },
  },
}));

vi.mock("electron", () => ({
  app: {
    on: (event: string, fn: (...args: never[]) => void) => {
      appEmitter.on(event, fn as (...args: unknown[]) => void);
    },
    removeListener: (event: string, fn: (...args: never[]) => void) => {
      appEmitter.off(event, fn as (...args: unknown[]) => void);
    },
  },
  ipcMain: {
    on: (channel: string, fn: (...args: never[]) => void) => {
      ipcListeners.set(channel, fn);
    },
    removeListener: (channel: string) => {
      ipcListeners.delete(channel);
    },
  },
  screen: {
    getCursorScreenPoint: () => ({ ...cursor }),
  },
}));

import { ShellRadialGestureService } from "../../electron/services/shell-radial-gesture-service.js";
import {
  RADIAL_SIZE,
  SHELL_RADIAL_SCALE,
} from "../../electron/layout-constants.js";

// libuiohook button numbering (uiohook.h): 1 left, 2 right, 3 middle. DOM
// numbering differs — the service must match uiohook's, and these constants
// pin that.
const UIOHOOK_LEFT = 1;
const UIOHOOK_RIGHT = 2;
const UIOHOOK_MIDDLE = 3;
const UIOHOOK_ESCAPE_KEYCODE = 1;

const CONTENT_BOUNDS = { x: 100, y: 50, width: 1200, height: 800 };

type SentMessage = { channel: string; payload: unknown };

const makeWindow = () => {
  const sent: SentMessage[] = [];
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getContentBounds: () => ({ ...CONTENT_BOUNDS }),
    on: vi.fn(),
    removeListener: vi.fn(),
    webContents: {
      send: (channel: string, payload?: unknown) => {
        sent.push({ channel, payload });
      },
    },
  };
  return { win, sent };
};

describe("shell radial gesture service", () => {
  let service: ShellRadialGestureService;
  let win: ReturnType<typeof makeWindow>["win"];
  let sent: SentMessage[];
  let radialBounds: { x: number; y: number } | null;
  let hookRunning: boolean;
  let overlay: {
    showShellRadial: ReturnType<typeof vi.fn>;
    hideRadial: ReturnType<typeof vi.fn>;
    updateRadialCursor: ReturnType<typeof vi.fn>;
    getRadialBounds: () => { x: number; y: number } | null;
  };

  const pressAt = (
    clientX: number,
    clientY: number,
    button = UIOHOOK_RIGHT,
  ) => {
    cursor.x = CONTENT_BOUNDS.x + clientX;
    cursor.y = CONTENT_BOUNDS.y + clientY;
    hookEmitter.emit("mousedown", { button });
  };

  const release = (button = UIOHOOK_RIGHT) => {
    hookEmitter.emit("mouseup", { button });
  };

  const domEvent = (channel: string) => {
    ipcListeners.get(channel)?.({ sender: win.webContents } as never);
  };

  const domBeginAt = (clientX: number, clientY: number) => {
    cursor.x = CONTENT_BOUNDS.x + clientX;
    cursor.y = CONTENT_BOUNDS.y + clientY;
    domEvent("shell-radial:dom-begin");
  };

  const lastQuery = (): { x: number; y: number; token: number } | null => {
    const query = [...sent]
      .reverse()
      .find((m) => m.channel === "shell-radial:query-press");
    return (query?.payload as { x: number; y: number; token: number }) ?? null;
  };

  const respond = (claim: boolean) => {
    const query = lastQuery();
    expect(query).not.toBeNull();
    ipcListeners.get("shell-radial:press-response")?.(
      { sender: win.webContents } as never,
      { token: query?.token, claim } as never,
    );
  };

  const commits = () => sent.filter((m) => m.channel === "shell-radial:commit");
  const endedSignals = () =>
    sent.filter((m) => m.channel === "shell-radial:ended");

  beforeEach(() => {
    vi.useFakeTimers();
    ({ win, sent } = makeWindow());
    radialBounds = null;
    hookRunning = true;
    overlay = {
      showShellRadial: vi.fn(() => {
        // Mirror the controller: the dial centers on the cursor at show time.
        radialBounds = {
          x: cursor.x - RADIAL_SIZE / 2,
          y: cursor.y - RADIAL_SIZE / 2,
        };
      }),
      hideRadial: vi.fn(),
      updateRadialCursor: vi.fn(),
      getRadialBounds: () => radialBounds,
    };
    service = new ShellRadialGestureService({
      getFullWindow: () => win as never,
      isSystemRadialActive: () => false,
      shouldEnable: () => true,
      isHookRunning: () => hookRunning,
      overlay,
    });
    service.start();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    hookEmitter.removeAllListeners();
    appEmitter.removeAllListeners();
    ipcListeners.clear();
  });

  describe("hook source", () => {
    it("registers the global listeners on start", () => {
      expect(hookEmitter.listenerCount("mousedown")).toBe(1);
      expect(hookEmitter.listenerCount("mouseup")).toBe(1);
      expect(ipcListeners.has("shell-radial:press-response")).toBe(true);
      expect(ipcListeners.has("shell-radial:dom-begin")).toBe(true);
      expect(ipcListeners.has("shell-radial:dom-leave")).toBe(true);
    });

    it("queries the renderer with window-relative coordinates on a right press", () => {
      pressAt(600, 400);
      expect(lastQuery()).toEqual({ x: 600, y: 400, token: 1 });
      expect(overlay.showShellRadial).not.toHaveBeenCalled();
    });

    it("ignores left and middle presses", () => {
      pressAt(600, 400, UIOHOOK_LEFT);
      pressAt(600, 400, UIOHOOK_MIDDLE);
      expect(lastQuery()).toBeNull();
    });

    it("ignores presses outside the window's content bounds", () => {
      cursor.x = CONTENT_BOUNDS.x - 10;
      cursor.y = CONTENT_BOUNDS.y + 100;
      hookEmitter.emit("mousedown", { button: UIOHOOK_RIGHT });
      expect(lastQuery()).toBeNull();
    });

    it("shows the dial when the renderer claims the press", () => {
      pressAt(600, 400);
      respond(true);
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
    });

    it("declines exempt presses without showing, and recovers for the next press", () => {
      pressAt(600, 400);
      respond(false);
      expect(overlay.showShellRadial).not.toHaveBeenCalled();

      release();
      pressAt(600, 400);
      expect(lastQuery()?.token).toBe(2);
      respond(true);
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
    });

    it("fails OPEN when the exemption query goes unanswered", () => {
      pressAt(600, 400);
      expect(overlay.showShellRadial).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
    });

    it("commits the wedge under the release and hides", () => {
      pressAt(600, 400);
      respond(true);

      // Drag up-right of the press point: the upper-right quadrant is index 0.
      cursor.x += 60;
      cursor.y -= 80;
      release();

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(commits()[0]?.payload).toEqual({ index: 0 });
      expect(endedSignals().length).toBe(1);
    });

    it("a dead-zone release dismisses without committing", () => {
      pressAt(600, 400);
      respond(true);
      release(); // cursor unchanged: exact center of the dial

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(commits()).toHaveLength(0);
      expect(endedSignals().length).toBe(1);
    });

    it("a left release mid-gesture does not end it", () => {
      pressAt(600, 400);
      respond(true);
      release(UIOHOOK_LEFT);
      expect(overlay.hideRadial).not.toHaveBeenCalled();
    });

    it("Escape cancels without committing", () => {
      pressAt(600, 400);
      respond(true);
      hookEmitter.emit("keydown", { keycode: UIOHOOK_ESCAPE_KEYCODE });

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(endedSignals().length).toBe(1);
      release();
      expect(commits()).toHaveLength(0);
    });

    it("cancels without committing when the pointer leaves the app", () => {
      pressAt(600, 400);
      respond(true);

      cursor.x = CONTENT_BOUNDS.x + CONTENT_BOUNDS.width + 1;
      hookEmitter.emit("mousemove", {});

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(endedSignals()).toHaveLength(1);
      release();
      expect(commits()).toHaveLength(0);
    });
  });

  describe("DOM source (permissionless)", () => {
    it("shows the dial immediately on dom-begin, with no query round trip", () => {
      domBeginAt(600, 400);
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
      expect(lastQuery()).toBeNull();
    });

    it("resolves a whole gesture from renderer events alone", () => {
      domBeginAt(600, 400);
      cursor.x += 60 * SHELL_RADIAL_SCALE;
      cursor.y -= 80 * SHELL_RADIAL_SCALE;
      domEvent("shell-radial:dom-move");
      expect(overlay.updateRadialCursor).toHaveBeenCalled();
      domEvent("shell-radial:dom-up");

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(commits()[0]?.payload).toEqual({ index: 0 });
      expect(endedSignals().length).toBe(1);
    });

    it("dom-cancel dismisses without committing", () => {
      domBeginAt(600, 400);
      domEvent("shell-radial:dom-cancel");
      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(commits()).toHaveLength(0);
    });

    it("ignores a renderer leave while the physical cursor is still inside", () => {
      domBeginAt(600, 400);
      domEvent("shell-radial:dom-leave");

      expect(overlay.hideRadial).not.toHaveBeenCalled();

      cursor.x += 60 * SHELL_RADIAL_SCALE;
      cursor.y -= 80 * SHELL_RADIAL_SCALE;
      domEvent("shell-radial:dom-up");
      expect(commits()).toHaveLength(1);
    });

    it("cancels a renderer leave when the physical cursor is outside", () => {
      domBeginAt(600, 400);
      cursor.x = CONTENT_BOUNDS.x + CONTENT_BOUNDS.width + 1;
      domEvent("shell-radial:dom-leave");

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(endedSignals()).toHaveLength(1);
      expect(commits()).toHaveLength(0);
    });

    it("the hook release resolves a DOM-begun gesture (drag into embedded content)", () => {
      domBeginAt(600, 400);
      // The DOM stream dies when the drag enters an iframe; the hook still
      // sees the physical release.
      cursor.x += 60;
      cursor.y -= 80;
      release();

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(commits()[0]?.payload).toEqual({ index: 0 });
    });
  });

  describe("source arbitration (no double-fire)", () => {
    it("dom-begin during a hook press's query collapses into the claim", () => {
      pressAt(600, 400);
      expect(overlay.showShellRadial).not.toHaveBeenCalled();
      domEvent("shell-radial:dom-begin");
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
      // The late explicit answer must not re-activate or re-show.
      respond(true);
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
    });

    it("a hook press is ignored while a DOM gesture is live", () => {
      domBeginAt(600, 400);
      pressAt(650, 420);
      expect(lastQuery()).toBeNull();
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
    });

    it("a second dom-begin is ignored while a gesture is live", () => {
      domBeginAt(600, 400);
      domEvent("shell-radial:dom-begin");
      expect(overlay.showShellRadial).toHaveBeenCalledTimes(1);
    });

    it("the duplicate release from the second source is a no-op", () => {
      domBeginAt(600, 400);
      cursor.x += 60;
      cursor.y -= 80;
      domEvent("shell-radial:dom-up");
      release(); // the hook sees the same physical release

      expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
      expect(commits()).toHaveLength(1);
    });
  });

  describe("swallowed-press surfacing (hook unavailable)", () => {
    it("reports an embedded-content press when the hook is dead", () => {
      const emitter = new EventEmitter();
      Object.assign(win.webContents, {
        mainFrame: { id: "main" },
        on: emitter.on.bind(emitter),
        emit: emitter.emit.bind(emitter),
        getType: () => "window",
        hostWebContents: null,
      });
      hookRunning = false;
      appEmitter.emit("web-contents-created", {}, win.webContents);
      emitter.emit(
        "context-menu",
        {},
        {
          isEditable: false,
          frame: { id: "child" },
        },
      );
      expect(
        sent.some((m) => m.channel === "shell-radial:swallowed-press"),
      ).toBe(true);
    });

    it("stays quiet when the hook is running", () => {
      const emitter = new EventEmitter();
      Object.assign(win.webContents, {
        mainFrame: { id: "main" },
        on: emitter.on.bind(emitter),
        emit: emitter.emit.bind(emitter),
        getType: () => "window",
        hostWebContents: null,
      });
      hookRunning = true;
      appEmitter.emit("web-contents-created", {}, win.webContents);
      emitter.emit(
        "context-menu",
        {},
        {
          isEditable: false,
          frame: { id: "child" },
        },
      );
      expect(
        sent.some((m) => m.channel === "shell-radial:swallowed-press"),
      ).toBe(false);
    });

    it("stays quiet for main-frame presses (renderer path owns those)", () => {
      const emitter = new EventEmitter();
      const mainFrame = { id: "main" };
      Object.assign(win.webContents, {
        mainFrame,
        on: emitter.on.bind(emitter),
        emit: emitter.emit.bind(emitter),
        getType: () => "window",
        hostWebContents: null,
      });
      hookRunning = false;
      appEmitter.emit("web-contents-created", {}, win.webContents);
      emitter.emit(
        "context-menu",
        {},
        {
          isEditable: false,
          frame: mainFrame,
        },
      );
      expect(
        sent.some((m) => m.channel === "shell-radial:swallowed-press"),
      ).toBe(false);
    });
  });
});
