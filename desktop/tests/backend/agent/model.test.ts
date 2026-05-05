import { describe, expect, it } from "bun:test";

import {
  getModeConfig,
  listManagedModelIds,
} from "../../../../backend/convex/agent/model";

describe("managed model config", () => {
  it("routes MiniMax through Fireworks", () => {
    const free = getModeConfig("free");

    expect(free.model).toBe("accounts/fireworks/models/minimax-m2p7");
    expect(free.managedGatewayProvider).toBe("fireworks");
    expect(free.providerOptions?.gateway?.order).toEqual(["fireworks"]);
  });

  it("uses Fireworks MiniMax as the fallback for best-tier aliases", () => {
    const best = getModeConfig("best");

    expect(best.fallback).toBe("accounts/fireworks/models/minimax-m2p7");
    expect(best.fallbackManagedGatewayProvider).toBe("fireworks");
    expect(best.fallbackProviderOptions?.gateway?.order).toEqual(["fireworks"]);
  });

  it("keeps the Fireworks MiniMax id in the managed model sync list", () => {
    expect(listManagedModelIds()).toContain(
      "accounts/fireworks/models/minimax-m2p7",
    );
  });
});
