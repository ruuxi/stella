import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../../../packages/stella-runtime/src/model-routing.js";

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
});
