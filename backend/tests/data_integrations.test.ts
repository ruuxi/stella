import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/data/integrations.ts", "utf-8");

describe("integrations module structure", () => {
  test("exports listPublicIntegrations", () => {
    expect(source).toContain("export const listPublicIntegrations =");
  });

  test("exports upsertPublicIntegration", () => {
    expect(source).toContain("export const upsertPublicIntegration =");
  });

  test("defines validators for doc shapes", () => {
    expect(source).toContain("publicIntegrationDocValidator");
    expect(source).toContain("userIntegrationDocValidator");
  });

  test("uses requireUserId for auth", () => {
    expect(source).toContain("requireUserId");
  });

  test("has args and returns validators", () => {
    const argsCount = (source.match(/\bargs:\s*\{/g) || []).length;
    expect(argsCount).toBeGreaterThanOrEqual(3);
  });
});
