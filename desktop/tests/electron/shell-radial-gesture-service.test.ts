/**
 * The shell radial dial's main-process gesture driver, exercised without an
 * app: uiohook and electron are mocked, and the tests drive the exact event
 * sequences a real gesture produces. The regression this guards against was
 * a silent no-op — a wrong button constant, a missing registration, or a
 * fail-closed exemption query all present as "right-click does nothing".
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookEmitter = new EventEmitter();
const ipcListeners = new Map<string, (...args: never[]) => void>();
const ipcHandlers = new Map<string, () => unknown>();
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
  ipcMain: {
    on: (channel: string, fn: (...args: never[]) => void) => {
      ipcListeners.set(channel, fn);
    },
    removeListener: (channel: string) => {
      ipcListeners.delete(channel);
    },
    handle: (channel: string, fn: () => unknown) => {
      ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    },
  },
  screen: {
    getCursorScreenPoint: () => ({ ...cursor }),
  },
}));

import { ShellRadialGestureService } from "../../electron/services/shell-radial-gesture-service.js";

// libuiohook button numbering (uiohook.h): 1 left, 2 right, 3 middle. DOM
// numbering differs (right is 2 there too, but middle is 1) — the service
// must match uiohook's, and these constants pin that.
const UIOHOOK_LEFT = 1;
const UIOHOOK_RIGHT = 2;
const UIOHOOK_MIDDLE = 3;
const UIOHOOK_ESCAPE_KEYCODE = 1;

const CONTENT_BOUNDS = { x: 100, y: 50, width: 1200, height: 800 };
const RADIAL_SIZE = 280;

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
      send: (channel: string, payload: unknown) => {
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

  beforeEach(() => {
    vi.useFakeTimers();
    ({ win, sent } = makeWindow());
    radialBounds = null;
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
      isHookRunning: () => true,
      overlay,
    });
    service.start();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    hookEmitter.removeAllListeners();
    ipcListeners.clear();
    ipcHandlers.clear();
  });

  it("registers the global listeners and the hook-liveness handler on start", () => {
    expect(hookEmitter.listenerCount("mousedown")).toBe(1);
    expect(hookEmitter.listenerCount("mouseup")).toBe(1);
    expect(ipcListeners.has("shell-radial:press-response")).toBe(true);
    expect(ipcHandlers.get("shell-radial:hook-live")?.()).toBe(true);
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
    const commit = sent.find((m) => m.channel === "shell-radial:commit");
    expect(commit?.payload).toEqual({ index: 0 });
  });

  it("a dead-zone release dismisses without committing", () => {
    pressAt(600, 400);
    respond(true);
    release(); // cursor unchanged: exact center of the dial

    expect(overlay.hideRadial).toHaveBeenCalledTimes(1);
    expect(
      sent.find((m) => m.channel === "shell-radial:commit"),
    ).toBeUndefined();
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
    release();
    expect(
      sent.find((m) => m.channel === "shell-radial:commit"),
    ).toBeUndefined();
  });
});
