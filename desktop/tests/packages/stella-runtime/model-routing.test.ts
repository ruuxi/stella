import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../../../electron/core/runtime/model-routing.js";

describe("managed model routing", () => {
  it("uses the managed API base URL instead of duplicating the chat completions path", () => {
    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: undefined,
      agentType: "orchestrator",
      proxy: {
        baseUrl: "https://demo.convex.site/api/managed-ai/chat/completions",
        getAuthToken: () => "token-123",
      },
    });

    expect(route.route).toBe("managed");
    expect(route.model.baseUrl).toBe("https://demo.convex.site/api/managed-ai");
  });

  it("does not bypass managed routing for kimi models without a local Kimi key", () => {
    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: "moonshotai/kimi-k2.5",
      agentType: "orchestrator",
      proxy: {
        baseUrl: "https://demo.convex.site/api/managed-ai",
        getAuthToken: () => "token-123",
      },
    });

    expect(route.route).toBe("managed");
    expect(route.model.provider).toBe("stella-managed");
    expect(route.model.id).toBe("default");
  });
});
