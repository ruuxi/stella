import { describe, expect, it } from "vitest";
import { normalizeSafeExternalUrl } from "../../../../packages/runtime-kernel/tools/network-guards.js";

describe("network-guards", () => {
  it("blocks localhost and private IP targets", async () => {
    await expect(normalizeSafeExternalUrl("http://localhost:3000")).rejects.toThrow(
      "Private and local network targets are blocked.",
    );
    await expect(normalizeSafeExternalUrl("https://192.168.1.20")).rejects.toThrow(
      "Private and local network targets are blocked.",
    );
  });

  it("blocks embedded credentials", async () => {
    await expect(
      normalizeSafeExternalUrl("https://user:pass@example.com"),
    ).rejects.toThrow("Embedded URL credentials are not allowed.");
  });
});
