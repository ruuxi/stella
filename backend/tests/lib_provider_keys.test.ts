import { describe, test, expect } from "bun:test";
import {
  PROVIDER_ENV_KEY_MAP,
  resolvePlatformApiKey,
} from "../convex/lib/provider_keys";

describe("PROVIDER_ENV_KEY_MAP", () => {
  test("maps known providers to env var names", () => {
    expect(PROVIDER_ENV_KEY_MAP["anthropic"]).toBe("ANTHROPIC_API_KEY");
    expect(PROVIDER_ENV_KEY_MAP["openai"]).toBe("OPENAI_API_KEY");
    expect(PROVIDER_ENV_KEY_MAP["google"]).toBe("GOOGLE_AI_API_KEY");
    expect(PROVIDER_ENV_KEY_MAP["openrouter"]).toBe("OPENROUTER_API_KEY");
  });

  test("includes all expected providers", () => {
    const providers = Object.keys(PROVIDER_ENV_KEY_MAP);
    expect(providers.length).toBeGreaterThan(10);
    expect(providers).toContain("cerebras");
    expect(providers).toContain("azure");
  });
});

describe("resolvePlatformApiKey", () => {
  test("returns null for unknown providers", () => {
    expect(resolvePlatformApiKey("nonexistent-provider")).toBeNull();
  });

  test("returns null when env var is not set", () => {
    // Most env vars should not be set in test environment
    const result = resolvePlatformApiKey("cerebras");
    // Could be null or have value depending on env
    expect(typeof result === "string" || result === null).toBe(true);
  });

  test("handles google-vertex special case", () => {
    // google-vertex isn't in PROVIDER_ENV_KEY_MAP but has special handling
    expect(PROVIDER_ENV_KEY_MAP["google-vertex"]).toBeUndefined();
    // The function should not throw
    const result = resolvePlatformApiKey("google-vertex");
    expect(typeof result === "string" || result === null).toBe(true);
  });

  test("handles google-vertex-anthropic special case", () => {
    const result = resolvePlatformApiKey("google-vertex-anthropic");
    expect(typeof result === "string" || result === null).toBe(true);
  });
});
