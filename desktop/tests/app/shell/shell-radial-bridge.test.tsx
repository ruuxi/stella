// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellRadialBridge } from "@/shell/radial/ShellRadialBridge";
import { radialSearchStore } from "@/shell/radial/radial-search-store";

describe("ShellRadialBridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalElectronApi: PropertyDescriptor | undefined;
  let commitHandler:
    | ((_event: unknown, data: { index: number }) => void)
    | undefined;

  const shellRadial = {
    beginDomGesture: vi.fn(),
    moveDomGesture: vi.fn(),
    endDomGesture: vi.fn(),
    cancelDomGesture: vi.fn(),
    leaveDomGesture: vi.fn(),
    respondPress: vi.fn(),
    onQueryPress: vi.fn(() => () => {}),
    onCommit: vi.fn(
      (handler: (_event: unknown, data: { index: number }) => void) => {
        commitHandler = handler;
        return () => {};
      },
    ),
    onEnded: vi.fn(() => () => {}),
    onSwallowedPress: vi.fn(() => () => {}),
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    commitHandler = undefined;
    radialSearchStore.close();
    originalElectronApi = Object.getOwnPropertyDescriptor(
      window,
      "electronAPI",
    );
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { shellRadial },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<ShellRadialBridge />));
  });

  afterEach(() => {
    act(() => root.unmount());
    radialSearchStore.close();
    container.remove();
    if (originalElectronApi) {
      Object.defineProperty(window, "electronAPI", originalElectronApi);
    } else {
      delete (window as { electronAPI?: unknown }).electronAPI;
    }
  });

  it("delegates renderer leave validation without cancelling locally", () => {
    act(() => {
      window.dispatchEvent(
        new MouseEvent("pointerdown", {
          button: 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(shellRadial.beginDomGesture).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new MouseEvent("pointerout", {
        bubbles: true,
        relatedTarget: null,
      }),
    );
    expect(shellRadial.cancelDomGesture).not.toHaveBeenCalled();

    act(() => {
      document.documentElement.dispatchEvent(
        new MouseEvent("mouseleave", {
          bubbles: false,
          relatedTarget: null,
        }),
      );
    });
    expect(shellRadial.leaveDomGesture).toHaveBeenCalledTimes(1);
    expect(shellRadial.cancelDomGesture).not.toHaveBeenCalled();
  });

  it("opens workspace search from the former Close wedge", () => {
    expect(commitHandler).toBeTypeOf("function");
    expect(radialSearchStore.getOpen()).toBe(false);

    act(() => {
      commitHandler?.({}, { index: 2 });
    });

    expect(radialSearchStore.getOpen()).toBe(true);
  });
});
