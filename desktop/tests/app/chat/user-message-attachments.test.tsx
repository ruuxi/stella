// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserMessageRow } from "@/app/chat/MessageRow";
import type { UserRowViewModel } from "@/features/chat/conversation-row-types";

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
}

const row: UserRowViewModel = {
  kind: "user",
  id: "user-with-image",
  text: "Look at this",
  attachments: [
    {
      id: "image-1",
      url: "data:image/png;base64,aW1hZ2U=",
      mimeType: "image/png",
      name: "example.png",
    },
  ],
};

const pdfRow: UserRowViewModel = {
  kind: "user",
  id: "user-with-pdf",
  text: "Here is my resume",
  attachments: [
    {
      id: "pdf-1",
      url: "data:application/pdf;base64,cGRm",
      mimeType: "application/pdf",
      name: "old-league-coaching-resume.pdf",
      size: 48_128,
      kind: "file",
    },
  ],
};

const legacyPdfRow: UserRowViewModel = {
  kind: "user",
  id: "user-with-legacy-pdf",
  text: "Older message without file metadata",
  attachments: [
    {
      id: "pdf-legacy",
      url: "data:application/pdf;base64,cGRm",
      mimeType: "application/pdf",
    },
  ],
};

describe("sent user image attachments", () => {
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

  it("reuses the composer's compact image chip above the user bubble", async () => {
    await act(async () => {
      root.render(<UserMessageRow row={row} />);
    });

    const chip = container.querySelector<HTMLButtonElement>(
      ".event-context-chips > .composer-chip-shell > button",
    );
    const image = chip?.querySelector("img");
    const bubble = container.querySelector(".event-item.user");

    expect(chip).not.toBeNull();
    expect(
      [
        "chat-composer-context-chip--screenshot",
        "composer-context-chip--screenshot",
        "chat-composer-context-region-card",
        "composer-chip-previewable",
      ].every((className) => chip!.classList.contains(className)),
    ).toBe(true);
    expect(chip!.dataset.regionCard).toBe("true");
    expect(
      ["chat-composer-context-region-thumb", "composer-context-thumb"].every(
        (className) => image!.classList.contains(className),
      ),
    ).toBe(true);
    expect(container.querySelector(".composer-chip-remove")).toBeNull();
    expect(
      chip!.compareDocumentPosition(bubble!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps click-to-enlarge through the shared image lightbox", async () => {
    await act(async () => {
      root.render(<UserMessageRow row={row} />);
    });

    const chip = container.querySelector<HTMLButtonElement>(
      ".event-context-chips > .composer-chip-shell > button",
    );
    await act(async () => chip!.click());

    const preview = document.body.querySelector<HTMLImageElement>(
      '[data-slot="image-lightbox-image"]',
    );
    expect(preview).not.toBeNull();
    expect(preview!.getAttribute("src")).toBe(row.attachments[0].url);
    expect(preview!.getAttribute("alt")).toBe("example.png");
  });

  it("renders non-image attachments as the composer's document chip, not an <img>", async () => {
    await act(async () => {
      root.render(<UserMessageRow row={pdfRow} />);
    });

    const chip = container.querySelector<HTMLButtonElement>(
      ".event-context-chips .chat-composer-file-chip",
    );
    expect(chip).not.toBeNull();
    // No broken <img>: the PDF must never be fed to an image element.
    expect(container.querySelector(".event-context-chips img")).toBeNull();
    // File-type glyph present.
    expect(chip!.querySelector(".chat-composer-file-icon svg")).not.toBeNull();
    // Real filename with extension survives truncation; full name in title.
    const name = chip!.querySelector(".chat-composer-file-name");
    expect(name!.textContent).toMatch(/\.pdf$/);
    expect(name!.textContent).not.toContain("Attachme");
    expect(chip!.getAttribute("title")).toBe("old-league-coaching-resume.pdf");
    // Size renders when persisted.
    expect(
      chip!.querySelector(".chat-composer-file-size")!.textContent,
    ).toBe("47 KB");
    // Sent chips expose no remove affordance.
    expect(container.querySelector(".composer-chip-remove")).toBeNull();
  });

  it("falls back to a type label when older payloads lack the filename", async () => {
    await act(async () => {
      root.render(<UserMessageRow row={legacyPdfRow} />);
    });

    const chip = container.querySelector<HTMLButtonElement>(
      ".event-context-chips .chat-composer-file-chip",
    );
    expect(chip).not.toBeNull();
    expect(container.querySelector(".event-context-chips img")).toBeNull();
    expect(
      chip!.querySelector(".chat-composer-file-name")!.textContent,
    ).toBe("PDF");
  });
});
