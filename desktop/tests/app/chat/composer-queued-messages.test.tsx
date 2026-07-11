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

const queued = (
  id: string,
  text = "Follow up",
  queueOrder = 1,
): QueuedUserMessage => ({
  id,
  text,
  timestamp: 100 + queueOrder,
  queueOrder,
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

  it("keeps one queued message as its normal text bubble", async () => {
    await act(async () => {
      root.render(
        <ComposerQueuedMessages
          messages={[queued("queued-single", "Only this message")]}
        />,
      );
    });

    expect(container.querySelectorAll(".composer-queued-message")).toHaveLength(
      1,
    );
    expect(container.querySelector(".composer-queued-message__bubble")?.textContent)
      .toBe("Only this message");
    expect(
      container.querySelector(".composer-queued-message__bubble--summary"),
    ).toBeNull();
  });

  it("collapses multiple messages and previews their ordered contents", async () => {
    const messages = [
      queued("queued-third", "Third in input", 3),
      queued("queued-first", "First in queue", 1),
      queued("queued-second", "Second in queue", 2),
    ];

    await act(async () => {
      root.render(<ComposerQueuedMessages messages={messages} />);
    });

    expect(container.querySelectorAll(".composer-queued-message")).toHaveLength(
      1,
    );
    const summary = container.querySelector<HTMLButtonElement>(
      ".composer-queued-message__bubble--summary",
    );
    expect(summary?.textContent).toBe("3 messages queued");
    expect(summary?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      summary!.dispatchEvent(new MouseEvent("mouseenter"));
    });

    const preview = document.body.querySelector(".composer-queued-preview");
    expect(preview).not.toBeNull();
    expect(summary?.getAttribute("aria-expanded")).toBe("true");
    expect(
      Array.from(
        preview!.querySelectorAll(".composer-queued-preview__text"),
        (node) => node.textContent,
      ),
    ).toEqual(["First in queue", "Second in queue", "Third in input"]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<ComposerQueuedMessages messages={messages} />);
    });
    expect(
      container.querySelector<HTMLElement>(".composer-queued-message")?.style
        .animation,
    ).toBe("none");
  });
});
