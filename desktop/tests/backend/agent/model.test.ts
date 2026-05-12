import { describe, expect, it } from "bun:test";

import {
  getModelConfig,
  getModeConfig,
  listManagedModelIds,
} from "../../../../backend/convex/agent/model";
import { AGENT_IDS } from "../../../../backend/convex/lib/agent_constants";
import { listStellaCatalogModels } from "../../../../backend/convex/stella_models";

describe("managed model config", () => {
  it("routes Light through OpenRouter", () => {
    const light = getModeConfig("light");

    expect(light.model).toBe("deepseek/deepseek-v4-flash");
    expect(light.managedGatewayProvider).toBe("openrouter");
    expect(light.providerOptions?.gateway?.order).toEqual(["openrouter"]);
  });

  it("uses Light as the fallback for Designer", () => {
    const designer = getModeConfig("designer");

    expect(designer.fallback).toBe("deepseek/deepseek-v4-flash");
    expect(designer.fallbackManagedGatewayProvider).toBe("openrouter");
    expect(designer.fallbackProviderOptions?.gateway?.order).toEqual([
      "openrouter",
    ]);
  });

  it("uses Standard for anonymous, free, and paid chat defaults", () => {
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "anonymous").model).toBe(
      "accounts/fireworks/models/kimi-k2p6",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "free").model).toBe(
      "accounts/fireworks/models/kimi-k2p6",
    );
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "go").model).toBe(
      "accounts/fireworks/models/kimi-k2p6",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "pro").model).toBe(
      "accounts/fireworks/models/kimi-k2p6",
    );
  });

  it("exposes Priority only for Pro and higher catalog audiences", () => {
    const isPriority = (model: { id: string }) =>
      model.id === "stella/priority";

    expect(listStellaCatalogModels("free").some(isPriority)).toBe(false);
    expect(listStellaCatalogModels("go").some(isPriority)).toBe(false);
    expect(listStellaCatalogModels("pro").find(isPriority)).toMatchObject({
      name: "Stella Priority",
      upstreamModel: "accounts/fireworks/routers/kimi-k2p6-turbo",
    });
  });

  it("keeps the Light model id in the managed model sync list", () => {
    expect(listManagedModelIds()).toContain(
      "deepseek/deepseek-v4-flash",
    );
  });
});
