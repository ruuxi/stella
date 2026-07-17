import { describe, expect, it } from "vitest";
import {
  groupCatalogModelsByProvider,
  normalizeRuntimeCatalogModels,
  normalizeRuntimeCatalogSnapshot,
} from "@/global/settings/lib/model-catalog";
import { providerUsesRuntimeManagedAuth } from "@/global/settings/ProviderModelPanel";

describe("runtime model catalog", () => {
  it("shows supported and explicitly managed providers but hides other built-ins", () => {
    const base = {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text", "image"] as Array<"text" | "image">,
      contextWindow: 500_000,
      maxTokens: 128_000,
    };

    const models = normalizeRuntimeCatalogModels(
      [
        { ...base, id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
        {
          ...base,
          id: "private-model",
          name: "Private model",
          provider: "my-extension",
        },
        {
          ...base,
          id: "bedrock-model",
          name: "Bedrock model",
          provider: "amazon-bedrock",
        },
      ],
      [
        { id: "my-extension", authManaged: true, credentialless: false },
        { id: "xai", authManaged: true, credentialless: false },
      ],
    );

    expect(models.map((model) => model.id)).toEqual([
      "my-extension/private-model",
      "xai/grok-4.5",
    ]);
    const xai = groupCatalogModelsByProvider(models).find(
      (group) => group.provider === "xai",
    );
    expect(xai).toMatchObject({
      runtimeManaged: true,
      runtimeManagedAuth: true,
      runtimeCredentialless: false,
    });
    expect(
      providerUsesRuntimeManagedAuth({
        runtimeManagedAuth: xai?.runtimeManagedAuth ?? false,
        runtimeCredentialless: xai?.runtimeCredentialless ?? false,
      }),
    ).toBe(true);
    expect(
      providerUsesRuntimeManagedAuth({
        runtimeManagedAuth: false,
        runtimeCredentialless: true,
      }),
    ).toBe(true);
    expect(
      providerUsesRuntimeManagedAuth({
        runtimeManagedAuth: false,
        runtimeCredentialless: false,
      }),
    ).toBe(false);
  });

  it("preserves worker models.json errors in the managed catalog payload", () => {
    const payload = normalizeRuntimeCatalogSnapshot({
      revision: 7,
      models: [],
      runtimeManagedProviders: [],
      refreshedAt: null,
      configError: "Invalid models.json schema",
      catalogError: "xai: network offline",
    });

    expect(payload.revision).toBe(7);
    expect(payload.configError).toBe("Invalid models.json schema");
    expect(payload.catalogError).toBe("xai: network offline");
  });
});
