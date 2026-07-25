// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  MAX_APP_SELECTIONS,
  attachComposerAppSelectionContext,
  clearComposerAppSelectionContext,
  getComposerAppSelections,
  removeComposerAppSelectionContext,
} from "@/features/chat/composer-context";
import { AppSelectionChips } from "@/app/chat/ComposerContextChips";
import { UserMessageRow } from "@/app/chat/MessageRow";
import type { UserRowViewModel } from "@/features/chat/conversation-row-types";

type Selection = NonNullable<ChatContext["appSelection"]>;

const makeSelection = (label: string, overrides?: Partial<Selection>): Selection => ({
  label,
  snapshot: `[section] ${label}`,
  bounds: { x: 0, y: 0, width: 100, height: 80 },
  surface: "stella-ui",
  ...overrides,
});

const makeSetter = (initial: ChatContext | null) => {
  let current = initial;
  const set: Dispatch<SetStateAction<ChatContext | null>> = (value) => {
    current = typeof value === "function" ? value(current) : value;
  };
  return { set, get: () => current };
};

describe("multi select-area composer state", () => {
  it("appends each new selection instead of replacing", () => {
    const state = makeSetter(null);
    attachComposerAppSelectionContext(makeSelection("Sidebar"), state.set);
    attachComposerAppSelectionContext(makeSelection("Composer"), state.set);
    attachComposerAppSelectionContext(makeSelection("Header"), state.set);

    const selections = getComposerAppSelections(state.get());
    expect(selections.map((s) => s.label)).toEqual([
      "Sidebar",
      "Composer",
      "Header",
    ]);
    // Legacy mirror tracks the newest selection for single-slot readers.
    expect(state.get()?.appSelection?.label).toBe("Header");
  });

  it("dedupes an identical re-selection instead of double-chipping", () => {
    const state = makeSetter(null);
    attachComposerAppSelectionContext(makeSelection("Sidebar"), state.set);
    attachComposerAppSelectionContext(makeSelection("Sidebar"), state.set);

    expect(getComposerAppSelections(state.get())).toHaveLength(1);

    // Same label but different content is a distinct selection.
    attachComposerAppSelectionContext(
      makeSelection("Sidebar", { snapshot: "[section] Sidebar v2" }),
      state.set,
    );
    expect(getComposerAppSelections(state.get())).toHaveLength(2);
  });

  it("caps growth by dropping the oldest selection", () => {
    const state = makeSetter(null);
    for (let i = 0; i < MAX_APP_SELECTIONS + 2; i += 1) {
      attachComposerAppSelectionContext(makeSelection(`Area ${i}`), state.set);
    }
    const selections = getComposerAppSelections(state.get());
    expect(selections).toHaveLength(MAX_APP_SELECTIONS);
    expect(selections[0].label).toBe("Area 2");
    expect(selections[selections.length - 1].label).toBe(
      `Area ${MAX_APP_SELECTIONS + 1}`,
    );
  });

  it("removes selections individually and keeps the mirror in sync", () => {
    const state = makeSetter(null);
    attachComposerAppSelectionContext(makeSelection("A"), state.set);
    attachComposerAppSelectionContext(makeSelection("B"), state.set);
    attachComposerAppSelectionContext(makeSelection("C"), state.set);

    removeComposerAppSelectionContext(1, state.set);
    expect(getComposerAppSelections(state.get()).map((s) => s.label)).toEqual([
      "A",
      "C",
    ]);
    expect(state.get()?.appSelection?.label).toBe("C");

    removeComposerAppSelectionContext(1, state.set);
    expect(state.get()?.appSelection?.label).toBe("A");

    removeComposerAppSelectionContext(0, state.set);
    expect(getComposerAppSelections(state.get())).toHaveLength(0);
    expect(state.get()?.appSelection).toBeNull();
  });

  it("normalizes a legacy single-slot context into the list on append", () => {
    const state = makeSetter({
      window: null,
      appSelection: makeSelection("Legacy"),
    });
    attachComposerAppSelectionContext(makeSelection("Fresh"), state.set);
    expect(getComposerAppSelections(state.get()).map((s) => s.label)).toEqual([
      "Legacy",
      "Fresh",
    ]);
  });

  it("clears every selection at once", () => {
    const state = makeSetter(null);
    attachComposerAppSelectionContext(makeSelection("A"), state.set);
    attachComposerAppSelectionContext(makeSelection("B"), state.set);
    clearComposerAppSelectionContext(state.set);
    expect(getComposerAppSelections(state.get())).toHaveLength(0);
    expect(state.get()?.appSelection).toBeNull();
  });
});

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe("multi select-area chips", () => {
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

  it("renders one composer chip per selection, each with its own remove", async () => {
    const state = makeSetter(null);
    attachComposerAppSelectionContext(makeSelection("Sidebar"), state.set);
    attachComposerAppSelectionContext(makeSelection("Composer"), state.set);

    await act(async () => {
      root.render(
        <AppSelectionChips
          appSelections={getComposerAppSelections(state.get())}
          setChatContext={state.set}
        />,
      );
    });

    const pills = container.querySelectorAll(".context-pill--app-selection");
    expect(pills).toHaveLength(2);
    expect(pills[0].textContent).toContain("Sidebar");
    expect(pills[1].textContent).toContain("Composer");

    const removes = container.querySelectorAll<HTMLButtonElement>(
      ".composer-chip-remove",
    );
    expect(removes).toHaveLength(2);

    // Removing the second chip drops only that selection.
    await act(async () => removes[1].click());
    expect(getComposerAppSelections(state.get()).map((s) => s.label)).toEqual([
      "Sidebar",
    ]);
  });

  // jsdom reports zero layout metrics, which would always collapse the
  // sent row's chips into the "+N" pill. Fake chip/column widths so the
  // overflow math behaves like a real layout.
  const withLayoutMetrics = async (
    columnWidth: number,
    run: () => Promise<void>,
  ) => {
    const offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientWidth",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return 80;
      },
    });
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get() {
        return columnWidth;
      },
    });
    try {
      await run();
    } finally {
      if (offsetWidthDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetWidth",
          offsetWidthDescriptor,
        );
      }
      if (clientWidthDescriptor) {
        Object.defineProperty(
          Element.prototype,
          "clientWidth",
          clientWidthDescriptor,
        );
      }
    }
  };

  it("renders one sent-message pill per selection label", async () => {
    const row: UserRowViewModel = {
      kind: "user",
      id: "user-multi-selection",
      text: "look at both areas",
      appSelectionLabels: ["Sidebar", "Composer"],
      attachments: [],
    };

    await withLayoutMetrics(1000, async () => {
      await act(async () => {
        root.render(<UserMessageRow row={row} />);
      });
    });

    // Direct children only — the hidden measurement row duplicates every
    // chip, so an unscoped query would double-count.
    const pills = container.querySelectorAll(
      ".event-context-chips > .context-pill--app-selection",
    );
    expect(pills).toHaveLength(2);
    expect(pills[0].textContent).toContain("Sidebar");
    expect(pills[1].textContent).toContain("Composer");
  });

  it("collapses extra sent-message pills into the +N overflow", async () => {
    const row: UserRowViewModel = {
      kind: "user",
      id: "user-overflowing-selections",
      text: "all of these",
      appSelectionLabels: ["A", "B", "C", "D", "E", "F"],
      attachments: [],
    };

    await withLayoutMetrics(200, async () => {
      await act(async () => {
        root.render(<UserMessageRow row={row} />);
      });
    });

    const visiblePills = container.querySelectorAll(
      ".event-context-chips > .context-pill--app-selection",
    );
    expect(visiblePills.length).toBeGreaterThanOrEqual(1);
    expect(visiblePills.length).toBeLessThan(6);
    const overflow = container.querySelector(
      "button.event-context-chip--overflow",
    );
    expect(overflow).not.toBeNull();
    expect(overflow!.textContent).toBe(`+${6 - visiblePills.length}`);
  });
});
