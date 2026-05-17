import { describe, expect, it } from "vitest";
import {
  normalizeStellaSiteUrl,
  stellaRelayBaseUrlFromSiteUrl,
} from "../../../src/shared/stella-api.js";

describe("Stella relay URLs", () => {
  it("normalizes legacy and relay URLs back to the site root", () => {
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/v1")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/v1/runtime")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/openai/v1/responses")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/models")).toBe(
      "https://example.test",
    );
  });

  it("derives provider-native relay base URLs", () => {
    expect(stellaRelayBaseUrlFromSiteUrl("https://example.test", "anthropic")).toBe(
      "https://example.test/api/stella/anthropic",
    );
    expect(stellaRelayBaseUrlFromSiteUrl("https://example.test", "openai")).toBe(
      "https://example.test/api/stella/openai/v1",
    );
    expect(stellaRelayBaseUrlFromSiteUrl("https://example.test", "google")).toBe(
      "https://example.test/api/stella/google/v1beta",
    );
    expect(stellaRelayBaseUrlFromSiteUrl("https://example.test", "fireworks")).toBe(
      "https://example.test/api/stella/fireworks/v1",
    );
    expect(stellaRelayBaseUrlFromSiteUrl("https://example.test", "openrouter")).toBe(
      "https://example.test/api/stella/openrouter/api/v1",
    );
  });
});
