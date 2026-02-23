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

  test("webhook handlers apply message-level dedup", () => {
    const source = readBackendFile("convex/http.ts");

    expect(source).toContain("consumeWebhookDedup");
    expect(source).toContain('consumeWebhookDedup(ctx, "telegram"');
    expect(source).toContain('consumeWebhookDedup(\n          ctx,\n          "discord"');
    expect(source).toContain('consumeWebhookDedup(\n        ctx,\n        "slack"');
    expect(source).toContain('consumeWebhookDedup(\n        ctx,\n        "google_chat"');
    expect(source).toContain('consumeWebhookDedup(ctx, "teams"');
    expect(source).toContain('consumeWebhookDedup(ctx, "linq"');
  });

  test("cron tick requires successful claim before scheduling execution", () => {
    const source = readBackendFile("convex/scheduling/cron_jobs.ts");

    expect(source).toContain("expectedRunningAtMs");
    expect(source).toContain("const claimed = await ctx.runMutation");
    expect(source).toContain("if (!claimed) {");
  });

  test("fallback resolver preserves provider options", () => {
    const source = readBackendFile("convex/agent/model_resolver.ts");
    expect(source).toMatch(/resolveFallbackConfig[\s\S]*providerOptions/);
    expect(source).toContain("filterGatewayOptions(defaults.providerOptions");
  });

  test("anonymous device hashing requires configured salt", () => {
    const source = readBackendFile("convex/ai_proxy_data.ts");
    expect(source).toContain("Missing ANON_DEVICE_ID_HASH_SALT");
    expect(source).not.toContain("ANON_DEVICE_ID_HASH_SALT ?? \"\"");
  });

  test("thread mutators require owner-scoped arguments", () => {
    const source = readBackendFile("convex/data/threads.ts");

    expect(source).toMatch(/export const createThread = internalMutation\([\s\S]*ownerId:\s*v\.string\(\)/);
    expect(source).toMatch(/export const saveThreadMessages = internalMutation\([\s\S]*ownerId:\s*v\.string\(\)/);
    expect(source).toMatch(/export const deleteMessagesBefore = internalMutation\([\s\S]*ownerId:\s*v\.string\(\)/);
    expect(source).toMatch(/export const evictOldestThread = internalMutation\([\s\S]*ownerId:\s*v\.string\(\)/);
  });

  test("event queries paginate accurately for counting and filtered device feeds", () => {
    const source = readBackendFile("convex/events.ts");
    expect(source).toContain("countByConversation");
    expect(source).toContain("let total = 0;");
    expect(source).toContain("ownershipCache");
    expect(source).toContain("while (filtered.length < requestedItems && !isDone)");
  });

  test("discord signature verifier checks timestamp freshness", () => {
    const source = readBackendFile("convex/channels/discord.ts");
    expect(source).toContain("DISCORD_SIGNATURE_MAX_SKEW_SECONDS");
    expect(source).toContain("Math.abs(nowSeconds - timestampSeconds)");
  });

  test("automation runner caches builtin ensure operations between runs", () => {
    const source = readBackendFile("convex/automation/runner.ts");
    expect(source).toContain("BUILTIN_ENSURE_CACHE_TTL_MS");
    expect(source).toContain("await ensureBuiltins(ctx)");
  });
});
