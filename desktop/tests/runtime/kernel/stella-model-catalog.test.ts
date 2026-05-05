import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLlmRoute } from "../../../../runtime/kernel/model-routing.js";
import { withStellaModelCatalogMetadata } from "../../../../runtime/kernel/stella-model-catalog.js";
import { getFileEditToolFamily } from "../../../../runtime/kernel/tools/file-edit-policy.js";

const originalFetch = globalThis.fetch;

const site = (token: string) => ({
  baseUrl: "https://stella.example.test",
  getAuthToken: () => token,
});

describe("Stella model catalog metadata", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves stella/default through backend defaults for tool policy", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [],
          defaults: [
            {
              agentType: "general",
              model: "stella/default",
              resolvedModel: "openai/gpt-5.5",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const route = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
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
      stellaRoot: "/tmp/stella",
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

  it("classifies explicit Stella passthrough ids without fetching catalog", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
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
            data: [],
            defaults: [
              {
                agentType: "general",
                model: "stella/default",
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
            data: [],
            defaults: [
              {
                agentType: "general",
                model: "stella/default",
                resolvedModel: "openai/gpt-5.5",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
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
});
