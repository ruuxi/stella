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

  test("commands upsertMany requires auth and short-circuits when already seeded", () => {
    const commandSource = readBackendFile("convex/data/commands.ts");
    expect(commandSource).toMatch(/await requireUserId\(ctx\)/);
    expect(commandSource).toMatch(/if \(firstEnabled \|\| firstDisabled\) return \{ upserted: 0 \}/);
  });

  test("chat endpoint enforces sensitive session policy", () => {
    const source = readBackendFile("convex/http.ts");
    expect(source).toMatch(/assertSensitiveSessionPolicyAction/);
    expect(source).toMatch(/await assertSensitiveSessionPolicyAction\(ctx, identity\)/);
  });

  test("ai proxy consumes anon allowance atomically", () => {
    const source = readBackendFile("convex/ai_proxy.ts");
    expect(source).toMatch(/consumeDeviceAllowance/);
    expect(source).not.toMatch(/runQuery\(internal\.ai_proxy_data\.getDeviceUsage/);
    expect(source).not.toMatch(/runMutation\(internal\.ai_proxy_data\.incrementDeviceUsage/);
  });

  test("integration requests enforce unsafe-host guard", () => {
    const integrationProxySource = readBackendFile("convex/tools/integration_proxy.ts");
    const backendToolsSource = readBackendFile("convex/tools/backend.ts");
    const networkSafetySource = readBackendFile("convex/tools/network_safety.ts");

    expect(integrationProxySource).toMatch(/getUnsafeIntegrationHostError/);
    expect(backendToolsSource).toMatch(/getUnsafeIntegrationHostError/);
    expect(backendToolsSource).toMatch(/allowPrivateNetworkHosts:\s*mode === "private"/);
    expect(networkSafetySource).toContain("Host");
    expect(networkSafetySource).not.toContain("STELLA_ALLOW_PRIVATE_INTEGRATION_HOSTS");
  });

  test("integration request guidance disallows raw credential forwarding", () => {
    const generalPrompt = readBackendFile("convex/prompts/general.ts");
    const builtinSkillsPrompt = readBackendFile("convex/prompts/builtin_skills.ts");
    const backendToolsSource = readBackendFile("convex/tools/backend.ts");

    expect(generalPrompt).not.toContain("ephemeral session tokens");
    expect(backendToolsSource).not.toContain("pass them directly in request.headers");
    expect(builtinSkillsPrompt).not.toContain("request.headers");
    expect(backendToolsSource).toMatch(/does not accept credential headers in request\.headers/);
    expect(backendToolsSource).toMatch(/does not accept credential query params in request\.query/);
  });

  test("integration response handling includes credential redaction", () => {
    const backendToolsSource = readBackendFile("convex/tools/backend.ts");

    expect(backendToolsSource).toContain("redactIntegrationResponseData");
    expect(backendToolsSource).toContain("SENSITIVE_RESPONSE_FIELD_NAME_RE");
    expect(backendToolsSource).toContain("deriveIntegrationRedactionSecrets");
  });

  test("channel link codes are stored as hashes, not plaintext", () => {
    const source = readBackendFile("convex/channels/utils.ts");

    expect(source).toContain("codeHash");
    expect(source).toContain("codeSalt");
    expect(source).not.toContain('JSON.stringify({ code: args.code');
  });

  test("slack oauth state is stored as hash material, not plaintext", () => {
    const source = readBackendFile("convex/data/integrations.ts");

    expect(source).toContain("stateHash");
    expect(source).toContain("stateSalt");
    expect(source).not.toContain("state: parsed.state");
  });
});
