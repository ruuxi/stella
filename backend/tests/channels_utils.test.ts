import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/channels/utils.ts", "utf-8");

describe("channels/utils module structure", () => {
  test("exports connection queries", () => {
    expect(source).toContain("export const getConnectionByProviderAndExternalId =");
    expect(source).toContain("export const getConnectionByOwnerProviderAndExternalId =");
  });

  test("exports DM policy query", () => {
    expect(source).toContain("export const getDmPolicyConfig =");
  });

  test("exports connection mutations", () => {
    expect(source).toContain("export const createConnection =");
    expect(source).toContain("export const setConnectionConversation =");
  });

  test("exports DM policy mutations", () => {
    expect(source).toContain("export const setDmPolicy =");
    expect(source).toContain("export const setDmAllowlist =");
    expect(source).toContain("export const setDmDenylist =");
  });

  test("exports public queries", () => {
    expect(source).toContain("export const getConnection = query(");
    expect(source).toContain("export const deleteConnection = mutation(");
  });

  test("re-exports ensureOwnerConnection", () => {
    expect(source).toContain("export { ensureOwnerConnection }");
  });

  test("uses requireUserId for auth", () => {
    expect(source).toContain("requireUserId");
  });
});
