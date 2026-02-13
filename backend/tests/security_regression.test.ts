import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const backendRoot = path.resolve(import.meta.dir, "..");

const readBackendFile = (relativePath: string) =>
  readFileSync(path.join(backendRoot, relativePath), "utf-8");

describe("security regressions", () => {
  test("store package public APIs do not accept caller-supplied ownerId", () => {
    const source = readBackendFile("convex/data/store_packages.ts");

    expect(source).not.toMatch(
      /export const install = mutation\(\{[\s\S]*?args:\s*\{[\s\S]*?ownerId:\s*v\.string\(\)/,
    );
    expect(source).not.toMatch(
      /export const uninstall = mutation\(\{[\s\S]*?args:\s*\{[\s\S]*?ownerId:\s*v\.string\(\)/,
    );
    expect(source).not.toMatch(
      /export const getInstalled = query\(\{[\s\S]*?args:\s*\{[\s\S]*?ownerId:\s*v\.string\(\)/,
    );
  });

  test("public integration upsert is internal-only", () => {
    const source = readBackendFile("convex/data/integrations.ts");
    expect(source).toMatch(/export const upsertPublicIntegration = internalMutation\(/);
  });

  test("prompt builder forwards owner scope to internal skill/agent loaders", () => {
    const source = readBackendFile("convex/agent/prompt_builder.ts");
    expect(source).toMatch(/getAgentConfigInternal,\s*\{[\s\S]*ownerId:\s*options\?\.ownerId/);
    expect(source).toMatch(/listEnabledSkillsInternal,\s*\{[\s\S]*ownerId:\s*options\?\.ownerId/);
  });

  test("CORS is no longer wildcard-reflective", () => {
    const source = readBackendFile("convex/http.ts");
    expect(source).not.toContain('"Access-Control-Allow-Origin": origin ?? "*"');
    expect(source).toContain("const CORS_ALLOWED_ORIGINS");
    expect(source).toContain("rejectDisallowedCorsOrigin");
  });

  test("commands upsertMany short-circuits when already seeded", () => {
    const commandSource = readBackendFile("convex/data/commands.ts");
    expect(commandSource).toMatch(/if \(first\) return \{ upserted: 0 \}/);
  });
});

