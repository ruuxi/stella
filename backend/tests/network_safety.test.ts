import { describe, expect, test } from "bun:test";
import { getUnsafeIntegrationHostError } from "../convex/tools/network_safety";

describe("network safety", () => {
  test("allows public IPv6 literals", () => {
    const url = new URL("https://[2606:4700:4700::1111]/health");
    expect(getUnsafeIntegrationHostError(url)).toBeNull();
  });

  test("blocks loopback and private IPv6 literals", () => {
    expect(getUnsafeIntegrationHostError(new URL("https://[::1]/"))).toContain("blocked");
    expect(getUnsafeIntegrationHostError(new URL("https://[fd00::1]/"))).toContain("blocked");
  });

  test("blocks localhost hostnames", () => {
    expect(getUnsafeIntegrationHostError(new URL("https://localhost/api"))).toContain("blocked");
  });
});
