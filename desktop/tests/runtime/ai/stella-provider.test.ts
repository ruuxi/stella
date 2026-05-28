import { describe, expect, it } from "vitest";
import {
  normalizeStellaSiteUrl,
  stellaManagedRelayBaseUrlFromSiteUrl,
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
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/relay/v1/messages")).toBe(
      "https://example.test",
    );
  });

  it("derives the neutral managed relay base URL", () => {
    expect(stellaManagedRelayBaseUrlFromSiteUrl("https://example.test")).toBe(
      "https://example.test/api/stella/relay",
    );
  });
});
