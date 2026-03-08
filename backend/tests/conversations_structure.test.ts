import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/conversations.ts", "utf-8");

describe("conversations module structure", () => {
  test("exports getOrCreateDefaultConversation", () => {
    expect(source).toContain("export const getOrCreateDefaultConversation =");
  });

  test("exports createConversation", () => {
    expect(source).toContain("export const createConversation =");
  });

  test("exports getById", () => {
    expect(source).toContain("export const getById =");
  });

  test("exports getActiveThreadId", () => {
    expect(source).toContain("export const getActiveThreadId =");
  });

  test("uses requireUserId for auth", () => {
    expect(source).toContain("requireUserId");
  });

  test("has args and returns validators", () => {
    const argsCount = (source.match(/\bargs:\s*\{/g) || []).length;
    expect(argsCount).toBeGreaterThanOrEqual(4);
    expect(source).toContain("conversationDocValidator");
  });
});
