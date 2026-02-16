import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

type IdentityMapPayload = {
  version: number;
  mappings: Array<{
    real: { name: string; identifier: string };
    alias: { name: string; identifier: string };
    source: string;
  }>;
};

const setDiscoveryCategories = (categories: string[]) => {
  localStorage.setItem(DISCOVERY_CATEGORIES_KEY, JSON.stringify(categories));
};

describe("useDepseudonymize", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    delete window.electronAPI;
  });

  it("returns passthrough text when messages_notes discovery is disabled", async () => {
    setDiscoveryCategories(["dev_environment"]);
    const getIdentityMap = vi.fn();
    window.electronAPI = {
      getIdentityMap,
    } as unknown as typeof window.electronAPI;

    const { useDepseudonymize } = await import("./use-depseudonymize");
    const { result } = renderHook(() => useDepseudonymize());

    expect(result.current("Alias Name")).toBe("Alias Name");
    expect(getIdentityMap).not.toHaveBeenCalled();
  });

  it("loads mappings and replaces alias name + identifier", async () => {
    setDiscoveryCategories(["messages_notes"]);
    const getIdentityMap = vi.fn().mockResolvedValue({
      version: 1,
      mappings: [
        {
          real: { name: "PersonOne", identifier: "PersonOne@example.com" },
          alias: { name: "AliasPersonOne", identifier: "ALIAS_ID" },
          source: "messages_notes",
        },
      ],
    } satisfies IdentityMapPayload);
    window.electronAPI = {
      getIdentityMap,
    } as unknown as typeof window.electronAPI;

    const { useDepseudonymize } = await import("./use-depseudonymize");
    const { result } = renderHook(() => useDepseudonymize());

    await waitFor(() => {
      expect(result.current("AliasPersonOne")).toBe("PersonOne");
    });

    expect(result.current("ALIAS_ID")).toBe("PersonOne@example.com");
    expect(result.current("xAliasPersonOnex")).toBe("xAliasPersonOnex");
    expect(getIdentityMap).toHaveBeenCalledTimes(1);
  });

  it("prefers longer aliases before shorter ones", async () => {
    setDiscoveryCategories(["messages_notes"]);
    const getIdentityMap = vi.fn().mockResolvedValue({
      version: 1,
      mappings: [
        {
          real: { name: "Person", identifier: "person-id" },
          alias: { name: "Ann", identifier: "ANN" },
          source: "messages_notes",
        },
        {
          real: { name: "Person Full", identifier: "person-full-id" },
          alias: { name: "Ann Lee", identifier: "ANN_LEE" },
          source: "messages_notes",
        },
      ],
    } satisfies IdentityMapPayload);
    window.electronAPI = {
      getIdentityMap,
    } as unknown as typeof window.electronAPI;

    const { useDepseudonymize } = await import("./use-depseudonymize");
    const { result } = renderHook(() => useDepseudonymize());

    await waitFor(() => {
      expect(result.current("Ann Lee met Ann")).toBe("Person Full met Person");
    });
  });

  it("handles missing mappings gracefully", async () => {
    setDiscoveryCategories(["messages_notes"]);
    const getIdentityMap = vi.fn().mockResolvedValue({
      version: 1,
      mappings: [],
    } satisfies IdentityMapPayload);
    window.electronAPI = {
      getIdentityMap,
    } as unknown as typeof window.electronAPI;

    const { useDepseudonymize } = await import("./use-depseudonymize");
    const { result } = renderHook(() => useDepseudonymize());

    await waitFor(() => {
      expect(getIdentityMap).toHaveBeenCalledTimes(1);
    });

    expect(result.current("AliasPersonOne")).toBe("AliasPersonOne");
  });

  it("falls back to passthrough when identity map load throws", async () => {
    setDiscoveryCategories(["messages_notes"]);
    const getIdentityMap = vi.fn().mockRejectedValue(new Error("boom"));
    window.electronAPI = {
      getIdentityMap,
    } as unknown as typeof window.electronAPI;

    const { useDepseudonymize } = await import("./use-depseudonymize");
    const { result } = renderHook(() => useDepseudonymize());

    await waitFor(() => {
      expect(getIdentityMap).toHaveBeenCalledTimes(1);
    });

    expect(result.current("AliasPersonOne")).toBe("AliasPersonOne");
  });

  it("reuses module cache across remounts without reloading identity map", async () => {
    setDiscoveryCategories(["messages_notes"]);
    const getIdentityMap = vi.fn().mockResolvedValue({
      version: 1,
      mappings: [
        {
          real: { name: "PersonOne", identifier: "PersonOne@example.com" },
          alias: { name: "AliasPersonOne", identifier: "ALIAS_ID" },
          source: "messages_notes",
        },
      ],
    } satisfies IdentityMapPayload);
    window.electronAPI = {
      getIdentityMap,
    } as unknown as typeof window.electronAPI;

    const { useDepseudonymize } = await import("./use-depseudonymize");

    const first = renderHook(() => useDepseudonymize());
    await waitFor(() => {
      expect(first.result.current("AliasPersonOne")).toBe("PersonOne");
    });
    first.unmount();

    const second = renderHook(() => useDepseudonymize());
    expect(second.result.current("AliasPersonOne")).toBe("PersonOne");
    expect(getIdentityMap).toHaveBeenCalledTimes(1);
  });
});
