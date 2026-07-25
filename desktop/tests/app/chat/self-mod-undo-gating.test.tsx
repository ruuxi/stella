// @vitest-environment jsdom
/**
 * The Update card's Undo affordance is gated on the commit, not on the card.
 *
 * The card is staged from the run's tracked writes, so it can render before
 * (or entirely without) a commit. Undo reverts that commit, so it only appears
 * once the row carries a hash — a run whose commit failed keeps a working
 * Update button and simply never offers Undo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SelfModUndoButton } from "@/app/chat/SelfModUndoButton";
import type { SelfModApplied } from "@/features/chat/self-mod-types";

let container: HTMLDivElement;
let root: Root;
const applyCalls: Array<string | undefined> = [];
const revertCalls: Array<string | undefined> = [];

beforeEach(() => {
  applyCalls.length = 0;
  revertCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: {
      selfModApply: async (commitHash?: string) => {
        applyCalls.push(commitHash);
      },
      selfModRevert: async (commitHash?: string) => {
        revertCalls.push(commitHash);
      },
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (selfModApplied: SelfModApplied) => {
  act(() => {
    root.render(<SelfModUndoButton selfModApplied={selfModApplied} />);
  });
};

const actionButton = () =>
  container.querySelector<HTMLButtonElement>(".selfmod-card__action");

const card = (overrides: Partial<SelfModApplied>): SelfModApplied => ({
  applyId: "run-1",
  files: ["desktop/src/a.tsx"],
  batchIndex: 0,
  ...overrides,
});

describe("SelfModUndoButton", () => {
  it("offers Update on a pending card that has no commit yet", () => {
    render(card({ status: "pending" }));

    expect(actionButton()?.textContent).toBe("Update");
    expect(
      container.querySelector(".selfmod-card")?.getAttribute("data-state"),
    ).toBe("pending");
  });

  it("applies a card with no commit hash", async () => {
    render(card({ status: "pending" }));

    await act(async () => {
      actionButton()?.click();
    });

    // The click still reaches the worker; the stash, not the hash, is what
    // identifies what to apply.
    expect(applyCalls).toEqual([undefined]);
    // It lands in the applied state, still with no Undo to offer.
    expect(container.textContent).toContain("Stella was updated");
    expect(actionButton()).toBeNull();
  });

  it("withholds Undo on an applied card whose commit never landed", () => {
    render(card({ status: "applied" }));

    expect(
      container.querySelector(".selfmod-card")?.getAttribute("data-state"),
    ).toBe("idle");
    expect(container.textContent).toContain("Stella was updated");
    // No affordance at all rather than a button that cannot work.
    expect(actionButton()).toBeNull();
  });

  it("shows Undo once the commit lands", () => {
    render(card({ status: "applied" }));
    expect(actionButton()).toBeNull();

    // The row is patched with the hash when the commit finishes.
    render(card({ status: "applied", commitHash: "abc123" }));

    expect(actionButton()?.textContent).toBe("Undo");
  });

  it("reverts with the landed commit hash after confirming", async () => {
    render(card({ status: "applied", commitHash: "abc123" }));

    await act(async () => {
      actionButton()?.click();
    });
    expect(actionButton()?.textContent).toBe("Confirm");
    expect(revertCalls).toEqual([]);

    await act(async () => {
      actionButton()?.click();
    });

    expect(revertCalls).toEqual(["abc123"]);
    expect(container.textContent).toContain("Update undone");
  });
});
