// @vitest-environment jsdom
/**
 * Rendered-output contract for the completion card's fileless summary.
 *
 * The 0.0.386 muted-excerpt styling shipped with zero visible effect
 * because the CSS was written against an ASSUMED DOM: Streamdown does not
 * emit `<strong>`/`<b>` for bold (it renders
 * `<span data-streamdown="strong" class="font-semibold">`), and inside a
 * chat row the higher-specificity `.event-item.assistant .markdown` rule
 * (full-shell.chat.css) repaints the markdown root with the chat tokens
 * (--text-strong at --font-size-lg), silently beating any
 * `.agent-completion-card__summary .markdown` override.
 *
 * These tests pin BOTH halves of the fix so it can't silently detach again:
 *   1. The real rendered DOM: the summary renders inside the scoped
 *      wrapper, and bold/code/link surface as `data-streamdown` nodes (not
 *      the element names markdown.css styles).
 *   2. The stylesheet targets that real shape: the scoped rules reference
 *      the `data-streamdown` attributes, and the wrapper re-points the
 *      chat typography tokens instead of fighting the chat rule on
 *      specificity.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentCompletionCard } from "@/app/chat/AgentCompletionCard";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";

const CARD_CSS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/app/chat/agent-completion-card.css",
);

const filelessSection = (summary: string): AgentCompletionSection => ({
  agentId: "a1",
  title: "Restore composer activity pill",
  completedAtMs: 42,
  files: [],
  summary,
});

// The exact register of the live report: bold + inline code + a link.
const SUMMARY =
  "**Outcome: done.** Committed `desktop-v0.0.387` — see [notes](https://example.com).";

describe("AgentCompletionCard fileless summary rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderCard = async (summary: string) => {
    await act(async () => {
      root.render(<AgentCompletionCard sections={[filelessSection(summary)]} />);
    });
  };

  it("renders the summary inside the scoped wrapper with a .markdown root", async () => {
    await renderCard(SUMMARY);
    const markdownRoot = container.querySelector(
      ".agent-completion-card__summary .markdown",
    );
    expect(markdownRoot).not.toBeNull();
    expect(markdownRoot!.textContent).toContain("Outcome: done.");
    expect(markdownRoot!.textContent).toContain("desktop-v0.0.387");
  });

  it("emits bold/code/link as data-streamdown nodes — the shape the scoped CSS must target", async () => {
    await renderCard(SUMMARY);
    const scope = ".agent-completion-card__summary .markdown";
    const strong = container.querySelector(`${scope} [data-streamdown="strong"]`);
    const code = container.querySelector(
      `${scope} [data-streamdown="inline-code"]`,
    );
    const link = container.querySelector(`${scope} [data-streamdown="link"]`);
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("Outcome: done.");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("desktop-v0.0.387");
    expect(link).not.toBeNull();
    // Bold is a SPAN, not <strong>: element selectors alone would style
    // nothing. If this ever flips (Streamdown change), re-verify the
    // scoped CSS still matches the new shape before deleting the assert.
    expect(container.querySelector(`${scope} strong`)).toBeNull();
    expect(strong!.tagName).toBe("SPAN");
  });

  it("scoped stylesheet targets the emitted DOM and re-points the chat tokens", () => {
    const css = fs.readFileSync(CARD_CSS_PATH, "utf8");
    // Inline-node rules must reference what Streamdown actually emits.
    expect(css).toContain('[data-streamdown="strong"]');
    expect(css).toContain('[data-streamdown="inline-code"]');
    expect(css).toContain('[data-streamdown="link"]');
    // The wrapper must win against `.event-item.assistant .markdown` by
    // re-pointing the chat typography tokens (the chat surface's own
    // override contract), not by specificity.
    const summaryBlock = css.slice(
      css.indexOf(".agent-completion-card__summary {"),
      css.indexOf("}", css.indexOf(".agent-completion-card__summary {")),
    );
    expect(summaryBlock).toContain("--chat-text-color:");
    expect(summaryBlock).toContain("--chat-text-size:");
  });
});
