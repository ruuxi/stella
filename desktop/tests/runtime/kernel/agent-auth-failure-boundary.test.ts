import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../../../runtime/kernel/agent-core/agent.js";
import type { Model } from "../../../../runtime/ai/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Agent required-auth failure boundary", () => {
  it.each([
    'Required models.json API key for provider "required-auth" could not be resolved.',
    'Required models.json header "Authorization" for provider "required-auth" could not be resolved.',
  ])("fails before provider/network when auth resolution throws: %s", async (message) => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not be reached");
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    const model: Model<"openai-responses"> = {
      id: "required-model",
      name: "Required model",
      api: "openai-responses",
      provider: "required-auth",
      baseUrl: "https://required-auth.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };
    const getApiKey = vi.fn(async () => {
      throw new Error(message);
    });
    const agent = new Agent({
      initialState: { model },
      getApiKey,
    });

    await agent.prompt("Do not reach the provider.");

    expect(getApiKey).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(agent.state.error).toBe(message);
  });
});
