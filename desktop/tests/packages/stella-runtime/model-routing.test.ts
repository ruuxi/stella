import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../../../electron/core/runtime/model-routing.js";

describe("stella model routing", () => {
  it("uses the stella API base URL instead of duplicating the chat completions path", () => {
    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: undefined,
      agentType: "orchestrator",
      proxy: {
        baseUrl: "https://demo.convex.site/api/stella/v1/chat/completions",
        getAuthToken: () => "token-123",
      },
    });

    expect(route.route).toBe("stella");
    expect(route.model.baseUrl).toBe("https://demo.convex.site/api/stella/v1");
  });

  it("routes provider models through stella when no local key exists", () => {
    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: "moonshotai/kimi-k2.5",
      agentType: "orchestrator",
      proxy: {
        baseUrl: "https://demo.convex.site/api/stella/v1",
        getAuthToken: () => "token-123",
      },
    });

    expect(route.route).toBe("stella");
    expect(route.model.provider).toBe("stella");
    expect(route.model.id).toBe("stella/moonshotai/kimi-k2.5");
  });
});
