import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
} from "../../../../runtime/kernel/model-routing.js";
import {
  invalidateStellaModelCatalogCache,
  withStellaModelCatalogMetadata,
} from "../../../../runtime/kernel/stella-model-catalog.js";
import { getFileEditToolFamily } from "../../../../runtime/kernel/tools/file-edit-policy.js";

const originalFetch = globalThis.fetch;

const site = (token: string) => ({
  baseUrl: "https://stella.example.test",
  getAuthToken: () => token,
});

describe("Stella model catalog metadata", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateStellaModelCatalogCache();
    vi.restoreAllMocks();
  });

  it("resolves backend default selections through catalog defaults", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [],
          defaults: [
            {
              agentType: "general",
              model: "stella/standard",
              resolvedModel: "openai/gpt-5.5",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site: site("token-default"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      route,
      agentType: "general",
      site: site("token-default"),
      deviceId: "device-a",
    });

    expect(enriched.model.id).toBe("stella/default");
    expect(enriched.toolPolicyModel).toMatchObject({
      id: "openai/gpt-5.5",
      provider: "openai",
      api: "openai",
    });
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: enriched.toolPolicyModel ?? enriched.model,
      }),
    ).toBe("apply_patch");
  });

  it("resolves opaque Stella aliases from catalog upstreamModel", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "stella/soda",
              name: "Soda",
              provider: "stella",
              upstreamModel: "openai/gpt-5.5",
            },
          ],
          defaults: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/soda",
      agentType: "general",
      site: site("token-soda"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      route,
      agentType: "general",
      site: site("token-soda"),
      deviceId: "device-b",
    });

    expect(enriched.model.id).toBe("stella/soda");
    expect(enriched.toolPolicyModel?.id).toBe("openai/gpt-5.5");
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: enriched.toolPolicyModel ?? enriched.model,
      }),
    ).toBe("apply_patch");
  });

  it("lets an explicit catalog upstream outrank an unavailable local namespace", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "stella/gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                provider: "stella",
                upstreamModel: "openai/gpt-5.6-sol",
              },
            ],
            defaults: [],
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRouteForCatalogEnrichment({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/gpt-5.6-sol",
      agentType: "general",
      site: site("token-catalog-override"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      route,
      agentType: "general",
      site: site("token-catalog-override"),
      deviceId: "device-catalog-override",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enriched.model.id).toBe("stella/gpt-5.6-sol");
    expect(
      (
        enriched.model as typeof enriched.model & {
          upstreamModelId?: string;
        }
      ).upstreamModelId,
    ).toBe("gpt-5.6-sol");
    expect(enriched.toolPolicyModel?.id).toBe("openai/gpt-5.6-sol");
  });

  it("resolves the backend gpt-5.5 selection through its catalog upstream", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "stella/gpt-5.5",
                name: "GPT-5.5",
                provider: "stella",
                upstreamModel: "openai/gpt-5.5",
              },
            ],
            defaults: [],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const route = resolveLlmRouteForCatalogEnrichment({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/gpt-5.5",
      agentType: "general",
      site: site("token-gpt-5.5"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      route,
      agentType: "general",
      site: site("token-gpt-5.5"),
      deviceId: "device-gpt-5.5",
    });

    expect(enriched.toolPolicyModel?.id).toBe("openai/gpt-5.5");
    expect(
      (
        enriched.model as typeof enriched.model & {
          upstreamModelId?: string;
        }
      ).upstreamModelId,
    ).toBe("gpt-5.5");
  });

  it("fails after one catalog lookup when no override can resolve the model", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], defaults: [] }), {
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRouteForCatalogEnrichment({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/gpt-5.6-sol",
      agentType: "general",
      site: site("token-catalog-miss"),
      reasoningEffort: "high",
    });

    await expect(
      withStellaModelCatalogMetadata({
        route,
        agentType: "general",
        site: site("token-catalog-miss"),
        deviceId: "device-catalog-miss",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow(/codex\/gpt-5\.6-sol:high/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies explicit Stella passthrough ids without fetching catalog", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/anthropic/claude-opus-4.6",
      agentType: "general",
      site: site("token-passthrough"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      route,
      agentType: "general",
      site: site("token-passthrough"),
      deviceId: "device-a",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(enriched.toolPolicyModel).toMatchObject({
      id: "anthropic/claude-opus-4.6",
      provider: "anthropic",
      api: "anthropic",
    });
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: enriched.toolPolicyModel ?? enriched.model,
      }),
    ).toBe("write_edit");
  });

  it("uses modelCatalogUpdatedAt as the cache invalidation key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "stella/standard",
                name: "Stella Standard",
                provider: "stella",
                upstreamModel: "anthropic/claude-opus-4.6",
              },
            ],
            defaults: [
              {
                agentType: "general",
                model: "stella/standard",
                resolvedModel: "anthropic/claude-opus-4.6",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "stella/standard",
                name: "Stella Standard",
                provider: "stella",
                upstreamModel: "openai/gpt-5.5",
              },
            ],
            defaults: [
              {
                agentType: "general",
                model: "stella/standard",
                resolvedModel: "openai/gpt-5.5",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site: site("token-updated-at"),
    });
    const first = await withStellaModelCatalogMetadata({
      route,
      agentType: "general",
      site: site("token-updated-at"),
      deviceId: "device-c",
      modelCatalogUpdatedAt: 1,
    });
    const second = await withStellaModelCatalogMetadata({
      route,
      agentType: "general",
      site: site("token-updated-at"),
      deviceId: "device-c",
      modelCatalogUpdatedAt: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.toolPolicyModel?.id).toBe("anthropic/claude-opus-4.6");
    expect(second.toolPolicyModel?.id).toBe("openai/gpt-5.5");
  });

  it("loads a matching catalog from disk after the in-memory cache is gone", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-model-catalog-"),
    );
    try {
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: [],
            defaults: [
              {
                agentType: "general",
                model: "stella/standard",
                resolvedModel: "openai/gpt-5.5",
              },
            ],
          }),
          { status: 200 },
        );
      });
      globalThis.fetch = fetchMock as typeof fetch;
      const route = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: undefined,
        agentType: "general",
        site: site("token-disk"),
      });

      const first = await withStellaModelCatalogMetadata({
        route,
        agentType: "general",
        site: site("token-disk"),
        deviceId: "device-d",
        modelCatalogUpdatedAt: 3,
        stellaDataDir,
      });
      invalidateStellaModelCatalogCache();
      const second = await withStellaModelCatalogMetadata({
        route,
        agentType: "general",
        site: site("token-disk"),
        deviceId: "device-d",
        modelCatalogUpdatedAt: 3,
        stellaDataDir,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.toolPolicyModel?.id).toBe("openai/gpt-5.5");
      expect(second.toolPolicyModel?.id).toBe("openai/gpt-5.5");
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });

  const catalogResponse = (resolvedModel: string) =>
    new Response(
      JSON.stringify({
        data: [],
        defaults: [
          { agentType: "general", model: "stella/standard", resolvedModel },
        ],
      }),
      { status: 200 },
    );

  it("serves the stale disk copy immediately on a version bump and refreshes in the background", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-model-catalog-"),
    );
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(catalogResponse("openai/gpt-5.5"))
        .mockResolvedValueOnce(catalogResponse("openai/gpt-6"));
      globalThis.fetch = fetchMock as typeof fetch;
      const route = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: undefined,
        agentType: "general",
        site: site("token-stale"),
      });
      const callWithVersion = (modelCatalogUpdatedAt: number) =>
        withStellaModelCatalogMetadata({
          route,
          agentType: "general",
          site: site("token-stale"),
          deviceId: "device-e",
          modelCatalogUpdatedAt,
          stellaDataDir,
        });

      await callWithVersion(1);
      invalidateStellaModelCatalogCache();

      // Version bumped: the v1 disk copy answers immediately (stale) while
      // the refresh happens behind the caller's back.
      const staleServed = await callWithVersion(2);
      expect(staleServed.toolPolicyModel?.id).toBe("openai/gpt-5.5");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      const refreshed = await callWithVersion(2);
      expect(refreshed.toolPolicyModel?.id).toBe("openai/gpt-6");
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("keeps serving the stale copy when the refresh fails, without hammering the endpoint", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-model-catalog-"),
    );
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(catalogResponse("openai/gpt-5.5"))
        .mockRejectedValue(new Error("backend mid-deploy"));
      globalThis.fetch = fetchMock as typeof fetch;
      const route = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: undefined,
        agentType: "general",
        site: site("token-stale-fail"),
      });
      const callWithVersion = (modelCatalogUpdatedAt: number) =>
        withStellaModelCatalogMetadata({
          route,
          agentType: "general",
          site: site("token-stale-fail"),
          deviceId: "device-f",
          modelCatalogUpdatedAt,
          stellaDataDir,
        });

      await callWithVersion(1);
      invalidateStellaModelCatalogCache();

      const first = await callWithVersion(2);
      expect(first.toolPolicyModel?.id).toBe("openai/gpt-5.5");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // Refresh failed; later calls still answer from the stale copy and
      // the failed attempt's spacing stops an immediate re-fetch.
      const second = await callWithVersion(2);
      expect(second.toolPolicyModel?.id).toBe("openai/gpt-5.5");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });
});
