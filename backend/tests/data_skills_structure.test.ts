import { describe, test, expect } from "bun:test";
import * as fs from "fs";

const source = fs.readFileSync("convex/data/skills.ts", "utf-8");

describe("skills module structure", () => {
  test("does not depend on backend builtin skill seeding", () => {
    expect(source).not.toContain("BUILTIN_SKILLS");
  });

  test("defines skill import validator", () => {
    expect(source).toContain("skillImportValidator");
  });

  test("exports upsertMany for skill import", () => {
    expect(source).toContain("export const upsertMany =");
  });

  test("exports skill listing queries", () => {
    // Check for list/get exports
    const hasListExport = source.includes("export const list") || source.includes("export const getSkill");
    expect(hasListExport).toBe(true);
  });

  test("uses requireUserId for auth", () => {
    expect(source).toContain("requireUserId");
  });

  test("supports skill secret mounts", () => {
    expect(source).toContain("secretMounts");
  });
});
