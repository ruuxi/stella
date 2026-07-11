// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerQueuedMessages } from "@/app/chat/ComposerQueuedMessages";
import type { QueuedUserMessage } from "@/features/chat/hooks/queued-user-messages";

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
}

const queued = (id: string): QueuedUserMessage => ({
  id,
  text: "Follow up",
  timestamp: 100,
  queueOrder: 1,
});

describe("ComposerQueuedMessages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("plays entry once when a queued virtual item is reconstructed", async () => {
    const message = queued("queued-animation-once");

    await act(async () => {
      root.render(<ComposerQueuedMessages messages={[message]} />);
    });
    expect(
      container.querySelector<HTMLElement>(".composer-queued-message")?.style
        .animation,
    ).toBe("");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<ComposerQueuedMessages messages={[message]} />);
    });

    expect(
      container.querySelector<HTMLElement>(".composer-queued-message")?.style
        .animation,
    ).toBe("none");
  });
});
