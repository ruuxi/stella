// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserMessageRow } from "@/app/chat/MessageRow";
import {
  AppSelectionChip,
  ScreenshotContextChips,
  WindowContextChip,
} from "@/app/chat/ComposerContextChips";
import type { UserRowViewModel } from "@/features/chat/conversation-row-types";

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
}

const noopSetChatContext = () => {};

const sentRow: UserRowViewModel = {
  kind: "user",
  id: "user-with-context",
  text: "compare the chips",
  windowLabel: "Workspace",
  appSelectionLabel: "Workspace",
  attachments: [
    {
      id: "image-1",
      url: "data:image/png;base64,aW1hZ2U=",
      mimeType: "image/png",
      name: "shot.png",
    },
  ],
};

describe("composer and sent-message chips share one visual system", () => {
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

  const pillShape = (pill: Element) => ({
    classes: [...pill.classList].sort().join(" "),
    hasIcon: Boolean(pill.querySelector("svg.context-pill__icon")),
    label: pill.querySelector(".context-pill__label")?.textContent,
  });

  it("renders the app-selection pill identically before and after send", async () => {
    await act(async () => {
      root.render(
        <>
          <div data-surface="composer">
            <AppSelectionChip
              appSelection={{ label: "Workspace" }}
              setChatContext={noopSetChatContext}
            />
          </div>
          <div data-surface="sent">
            <UserMessageRow row={sentRow} />
          </div>
        </>,
      );
    });

    const composerPill = container.querySelector(
      '[data-surface="composer"] .context-pill--app-selection',
    );
    const sentPill = container.querySelector(
      '[data-surface="sent"] .context-pill--app-selection',
    );
    expect(composerPill).not.toBeNull();
    expect(sentPill).not.toBeNull();
    // Same classes, same glyph, same label — one system on both surfaces.
    expect(pillShape(composerPill!)).toEqual(pillShape(sentPill!));
    // Behavior stays per-surface: composer body is a button with a remove
    // ×; the sent pill is a plain span with no remove affordance.
    expect(composerPill!.tagName).toBe("BUTTON");
    expect(sentPill!.tagName).toBe("SPAN");
    expect(
      container.querySelector('[data-surface="composer"] .composer-chip-remove'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-surface="sent"] .composer-chip-remove'),
    ).toBeNull();
  });

  it("renders the window pill identically before and after send", async () => {
    await act(async () => {
      root.render(
        <>
          <div data-surface="composer">
            <WindowContextChip
              chatWindow={{ app: "Workspace" }}
              setChatContext={noopSetChatContext}
            />
          </div>
          <div data-surface="sent">
            <UserMessageRow row={sentRow} />
          </div>
        </>,
      );
    });

    const composerPill = container.querySelector(
      '[data-surface="composer"] .context-pill--window',
    );
    const sentPill = container.querySelector(
      '[data-surface="sent"] .context-pill--window',
    );
    expect(composerPill).not.toBeNull();
    expect(sentPill).not.toBeNull();
    expect(pillShape(composerPill!)).toEqual(pillShape(sentPill!));
    // No broken plain-cream pill: the canonical pill always leads with
    // its type glyph.
    expect(
      composerPill!.querySelector("svg.context-pill__icon"),
    ).not.toBeNull();
  });

  it("renders image thumbnail cards with identical classes before and after send", async () => {
    await act(async () => {
      root.render(
        <>
          <div data-surface="composer">
            <ScreenshotContextChips
              screenshots={[
                { dataUrl: "data:image/png;base64,aW1hZ2U=", width: 8, height: 6 },
              ]}
              setChatContext={noopSetChatContext}
            />
          </div>
          <div data-surface="sent">
            <UserMessageRow row={sentRow} />
          </div>
        </>,
      );
    });

    const composerCard = container.querySelector<HTMLButtonElement>(
      '[data-surface="composer"] button[data-region-card="true"]',
    );
    const sentCard = container.querySelector<HTMLButtonElement>(
      '[data-surface="sent"] button[data-region-card="true"]',
    );
    expect(composerCard).not.toBeNull();
    expect(sentCard).not.toBeNull();
    expect([...composerCard!.classList].sort()).toEqual(
      [...sentCard!.classList].sort(),
    );
    expect([...composerCard!.querySelector("img")!.classList].sort()).toEqual(
      [...sentCard!.querySelector("img")!.classList].sort(),
    );
  });
});
