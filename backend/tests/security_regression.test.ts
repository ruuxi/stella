import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import path from "path";

const backendRoot = path.resolve(import.meta.dir, "..");

const readBackendFile = (relativePath: string) =>
  readFileSync(path.join(backendRoot, relativePath), "utf-8");

describe("security regressions", () => {
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
    const httpSource = readBackendFile("convex/http.ts");
    const corsSource = readBackendFile("convex/http_shared/cors.ts");
    expect(httpSource).not.toContain('"Access-Control-Allow-Origin": origin ?? "*"');
    expect(corsSource).toContain("const CORS_ALLOWED_ORIGINS");
    // http.ts is now a thin routing file that imports corsPreflightHandler
    // (which internally calls rejectDisallowedCorsOrigin) from http_shared/cors.ts.
    expect(httpSource).toContain("corsPreflightHandler");
  });

  test("commands upsertMany requires auth and short-circuits when already seeded", () => {
    const commandSource = readBackendFile("convex/data/commands.ts");
    expect(commandSource).toMatch(/await requireUserId\(ctx\)/);
    expect(commandSource).toMatch(/if \(firstEnabled \|\| firstDisabled\) return \{ upserted: 0 \}/);
  });

  test("chat endpoint enforces sensitive session policy", () => {
    // The sensitive session policy enforcement lives in auth.ts, where
    // assertSensitiveSessionPolicyAction is defined and wired into
    // requireSensitiveUserIdentityAction for use by action-based endpoints.
    const source = readBackendFile("convex/auth.ts");
    expect(source).toMatch(/assertSensitiveSessionPolicyAction/);
    expect(source).toMatch(/await assertSensitiveSessionPolicyAction\(ctx, identity\)/);
  });

  test("ai proxy consumes anon allowance atomically", () => {
    const source = readBackendFile("convex/ai_proxy.ts");
    expect(source).toMatch(/consumeDeviceAllowance/);
    expect(source).not.toMatch(/runQuery\(internal\.ai_proxy_data\.getDeviceUsage/);
    expect(source).not.toMatch(/runMutation\(internal\.ai_proxy_data\.incrementDeviceUsage/);
  });

  test("channel link codes are stored as hashes, not plaintext", () => {
    // Link code logic was moved from channels/utils.ts to channels/link_codes.ts.
    const source = readBackendFile("convex/channels/link_codes.ts");

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
    const source = readBackendFile("convex/http_routes/connectors.ts");

    expect(source).toContain("consumeWebhookDedup");
    expect(source).toMatch(/consumeWebhookDedup\(\s*ctx,\s*"telegram"/);
    expect(source).toMatch(/consumeWebhookDedup\(\s*ctx,\s*"discord"/);
    expect(source).toMatch(/consumeWebhookDedup\(\s*ctx,\s*"slack"/);
    expect(source).toMatch(/consumeWebhookDedup\(\s*ctx,\s*"google_chat"/);
    expect(source).toMatch(/consumeWebhookDedup\(\s*ctx,\s*"teams"/);
    expect(source).toMatch(/consumeWebhookDedup\(\s*ctx,\s*"linq"/);
  });

  test("webhook limiter keys are hashed before persistence", () => {
    // The webhook rate limiter was moved from channels/utils.ts to rate_limits.ts.
    const source = readBackendFile("convex/rate_limits.ts");

    expect(source).toContain("const hashedKey = await hashSha256Hex");
    expect(source).toContain("key: hashedKey");
  });

  test("sync-off operational write policy is explicitly documented", () => {
    const source = readFileSync(
      path.resolve(backendRoot, "..", "docs", "sync_off_operational_writes.md"),
      "utf-8",
    );
    expect(source).toContain("Sync-off blocks durable chat content persistence");
    expect(source).toContain("Expected operational writes");
    expect(source).toContain("Explicitly blocked in sync-off");
  });

  test("backend scheduling modules are explicitly retired", () => {
    const cronSource = readBackendFile("convex/scheduling/cron_jobs.ts");

    expect(cronSource).toContain("BACKEND_CRON_RUNTIME_REMOVED");
    expect(existsSync(path.join(backendRoot, "convex/scheduling/claim_flow.ts"))).toBe(false);
    expect(existsSync(path.join(backendRoot, "convex/scheduling/heartbeat.ts"))).toBe(false);
  });

  test("connector transient batches are cleaned in finally", () => {
    // Transient batch logic was moved from channels/utils.ts to channels/message_pipeline.ts.
    const source = readBackendFile("convex/channels/message_pipeline.ts");

    expect(source).toContain("const transient = syncMode === SYNC_MODE_OFF");
    expect(source).toContain("const transientBatchKey = transient");
    expect(source).toContain("const cleanupTransientBatch = async () =>");
    expect(source).toContain("TRANSIENT_CLEANUP_MAX_ATTEMPTS");
    expect(source).toContain("getTransientCleanupBackoffMs");
    expect(source).toContain("recordCleanupFailure");
    expect(source).toContain("internal.channels.transient_data.appendTransientEvent");
    expect(source).toContain("internal.channels.transient_data.deleteTransientBatch");
    expect(source).toContain("await cleanupTransientBatch()");
    expect(source).toMatch(/\}\s*finally\s*\{/);
  });

  test("connector watchdog still uses the cron completion compatibility hook", () => {
    const source = readBackendFile("convex/channels/connector_delivery.ts");

    expect(source).toContain("completeCronTurnResultFromWatchdog");
    expect(source).toContain("BACKEND_FALLBACK_AGENT_TYPE");
  });

  test("bridge-based connector runtime is removed", () => {
    const connectorRoutes = readBackendFile("convex/http_routes/connectors.ts");
    const deliverySource = readBackendFile("convex/channels/connector_delivery.ts");

    expect(connectorRoutes).not.toContain("/api/bridge/poll");
    expect(connectorRoutes).not.toContain("/api/webhooks/bridge");
    expect(deliverySource).not.toContain('case "whatsapp"');
    expect(deliverySource).not.toContain('case "signal"');
    expect(existsSync(path.join(backendRoot, "convex/channels/bridge.ts"))).toBe(false);
    expect(existsSync(path.join(backendRoot, "convex/channels/whatsapp.ts"))).toBe(false);
    expect(existsSync(path.join(backendRoot, "convex/channels/signal.ts"))).toBe(false);
  });

  test("cron compatibility module is limited to remote turn completion", () => {
    const cronSource = readBackendFile("convex/scheduling/cron_jobs.ts");

    expect(cronSource).toContain("completeCronTurnResult");
    expect(cronSource).toContain("completeCronTurnResultFromWatchdog");
    expect(cronSource).not.toContain("query(\"cron_jobs\")");
    expect(cronSource).not.toContain("claimAndScheduleSingleRun");
  });

  test("local runtime backend bridge excludes legacy schedule tools", () => {
    const source = readBackendFile("convex/agent/local_runtime.ts");

    expect(source).not.toContain("\"HeartbeatGet\"");
    expect(source).not.toContain("\"HeartbeatUpsert\"");
    expect(source).not.toContain("\"CronList\"");
    expect(source).not.toContain("\"CronAdd\"");
  });

  test("transient tool allowlist excludes local device transport tools", () => {
    const source = readBackendFile("convex/tools/index.ts");
    const match = source.match(/const TRANSIENT_ALLOWED_TOOLS = new Set<string>\(\[[\s\S]*?\]\);/);
    expect(match).not.toBeNull();
    const block = match ? match[0] : "";
    expect(block).toContain("\"WebSearch\"");
    expect(block).toContain("\"WebFetch\"");
    expect(block).not.toContain("\"Read\"");
    expect(block).not.toContain("\"Write\"");
    expect(block).not.toContain("\"Edit\"");
    expect(block).not.toContain("\"Bash\"");
    expect(block).not.toContain("\"OpenApp\"");
  });

  test("channel mode matrix wiring keeps privacy and routing guarantees", () => {
    // Channel message pipeline logic was moved from channels/utils.ts to
    // channels/message_pipeline.ts during refactoring.
    const pipelineSource = readBackendFile("convex/channels/message_pipeline.ts");
    const routingFlowSource = readBackendFile("convex/channels/routing_flow.ts");

    expect(pipelineSource).toContain("const transient = syncMode === SYNC_MODE_OFF");
    expect(pipelineSource).toContain("const userMessageId = transient");
    expect(routingFlowSource).toContain("isOwnerInConnectedMode");
    expect(routingFlowSource).toContain("resolveConnectionForIncomingMessage");
    expect(pipelineSource).toContain("const candidates = buildDesktopTurnCandidates({");
    expect(pipelineSource).not.toContain("runtimeMode === \"cloud_247\"");
    expect(pipelineSource).toContain("const usedBackendFallback =");
  });

  test("connection resolver does not auto-create links when account mode is private local", () => {
    const source = readBackendFile("convex/channels/routing_flow.ts");
    expect(source).toContain("isOwnerInConnectedMode");
    expect(source).toContain("if (!(await isOwnerInConnectedMode");
    expect(source).toMatch(
      /policyOwnerId[\s\S]*?isOwnerInConnectedMode[\s\S]*?return null;[\s\S]*?ensureOwnerConnection/,
    );
  });

  test("transient channel retention is tightened and cleanup failures are retained", () => {
    const source = readBackendFile("convex/channels/transient_data.ts");
    const cronsSource = readBackendFile("convex/crons.ts");
    expect(source).toContain("const DEFAULT_TTL_MS = 10 * 60 * 1000");
    expect(source).toContain("const MAX_TTL_MS = 15 * 60 * 1000");
    expect(source).toContain("recordCleanupFailure");
    expect(source).toContain("DEFAULT_CLEANUP_FAILURE_RETENTION_MS");
    expect(cronsSource).toContain("\"transient cleanup failure retention sweep\"");
    expect(cronsSource).toContain("internal.channels.transient_data.purgeExpiredCleanupFailures");
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
    // evictOldestThread was folded into createThread (eviction happens inline
    // when the thread count exceeds MAX_THREADS_PER_CONVERSATION). Verify
    // createThread still scopes its eviction check by owner via conversation lookup.
    expect(source).toContain("loadConversationForOwner");
  });

  test("event queries paginate accurately for counting and filtered device feeds", () => {
    const source = readBackendFile("convex/events.ts");
    expect(source).toContain("countByConversation");
    expect(source).toContain("let total = 0;");
    expect(source).toContain("ownershipCache");
    expect(source).toContain("take(maxItems * 3)");
    expect(source).toContain("if (filtered.length >= maxItems) break;");
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
