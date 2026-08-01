// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrandIcon } from "@/ui/brand-icon";
import {
  compareProviderRailOrder,
  getLlmProviderEntry,
} from "@/global/settings/lib/llm-providers";

describe("provider presentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses the Claude app mark for Anthropic", async () => {
    await act(async () => {
      root.render(<BrandIcon brand="anthropic" size={18} />);
    });

    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 691 691");
    expect(icon?.querySelector('rect[rx="161.953"]')).not.toBeNull();
  });

  it("uses the preferred provider rail order before the remaining providers", () => {
    const keys = [
      "mistral",
      "openrouter",
      "zai",
      "kimi-coding",
      "google",
      "github-copilot",
      "xai",
      "openai-codex",
      "openai",
      "anthropic",
      "stella",
      "groq",
      "cerebras",
    ];
    const sorted = keys.toSorted((a, b) =>
      compareProviderRailOrder(
        a,
        b,
        getLlmProviderEntry(a)?.label ?? a,
        getLlmProviderEntry(b)?.label ?? b,
      ),
    );

    expect(sorted).toEqual([
      "stella",
      "anthropic",
      "openai",
      "openai-codex",
      "xai",
      "github-copilot",
      "google",
      "kimi-coding",
      "zai",
      "openrouter",
      "cerebras",
      "groq",
      "mistral",
    ]);
  });
});
