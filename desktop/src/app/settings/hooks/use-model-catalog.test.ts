import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelCatalog } from "./use-model-catalog";

describe("useModelCatalog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses fallback models when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));

    const { result } = renderHook(() => useModelCatalog());

    expect(result.current.loading).toBe(true);
    expect(result.current.models.length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Fallback list contains known ids
    expect(result.current.models.some((m) => m.id === "openai/gpt-5.2")).toBe(true);
    expect(result.current.groups.some((g) => g.provider === "openai")).toBe(true);
  });

  it("loads language models from catalog and groups by provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai/gpt-5.2", name: "GPT-5.2", type: "language" },
          { id: "openai/gpt-image", name: "GPT Image", type: "image" },
          { id: "anthropic/claude-sonnet-4-5", type: "language" },
          { id: "custom-model-no-slash", name: "Custom" },
        ],
      }),
    } as Response);

    const { result } = renderHook(() => useModelCatalog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.models).toHaveLength(3);
    });

    expect(result.current.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai/gpt-5.2", provider: "openai", name: "GPT-5.2" }),
        expect.objectContaining({ id: "anthropic/claude-sonnet-4-5", provider: "anthropic", name: "anthropic/claude-sonnet-4-5" }),
        expect.objectContaining({ id: "custom-model-no-slash", provider: "unknown", name: "Custom" }),
      ]),
    );

    const openaiGroup = result.current.groups.find((g) => g.provider === "openai");
    const anthropicGroup = result.current.groups.find((g) => g.provider === "anthropic");
    const unknownGroup = result.current.groups.find((g) => g.provider === "unknown");

    expect(openaiGroup?.models).toHaveLength(1);
    expect(anthropicGroup?.models).toHaveLength(1);
    expect(unknownGroup?.models).toHaveLength(1);
  });

  it("keeps fallback models when catalog responds with empty list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    const { result } = renderHook(() => useModelCatalog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.models.some((m) => m.id === "openai/gpt-5.2")).toBe(true);
    expect(result.current.groups.some((g) => g.provider === "google")).toBe(true);
  });
});
