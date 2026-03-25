import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "../convex/_generated/api";
import {
  enforceManagedUsageLimit,
  persistManagedUsage,
  recordMediaCompletedUsage,
  resolveManagedModelAccess,
  recordVoiceRealtimeUsage,
} from "../convex/billing";
import {
  computeUsageCostMicroCents,
  dollarsToMicroCents,
} from "../convex/lib/billing_money";
import { getPlanConfig } from "../convex/lib/billing_plans";
import { AUDIENCE_AGENT_MODELS, getModelConfig } from "../convex/agent/model";
import { stellaProviderChatCompletions } from "../convex/stella_provider";
import { syncSessionActivity } from "../convex/media_realtime_sessions";

type TableName =
  | "billing_profiles"
  | "billing_usage_windows"
  | "billing_model_prices"
  | "billing_voice_usage_receipts"
  | "billing_media_usage_receipts"
  | "media_realtime_sessions"
  | "conversations"
  | "usage_logs";

type Row = Record<string, unknown> & { _id: string };

type MemoryState = Record<TableName, Row[]>;

const makeState = (): MemoryState => ({
  billing_profiles: [],
  billing_usage_windows: [],
  billing_model_prices: [],
  billing_voice_usage_receipts: [],
  billing_media_usage_receipts: [],
  media_realtime_sessions: [],
  conversations: [],
  usage_logs: [],
});

const clone = <T>(value: T): T => structuredClone(value);

const createMemoryDb = (initial?: Partial<MemoryState>) => {
  const state = makeState();
  if (initial) {
    for (const [table, rows] of Object.entries(initial) as Array<
      [TableName, Row[] | undefined]
    >) {
      state[table] = (rows ?? []).map((row) => clone(row));
    }
  }

  let nextId = 1;

  const findRow = (id: string) => {
    for (const rows of Object.values(state)) {
      const row = rows.find((entry) => entry._id === id);
      if (row) return row;
    }
    return null;
  };

  const queryTable = (table: TableName) => ({
    withIndex: (
      _indexName: string,
      build?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
    ) => {
      const filters: Array<{ field: string; value: unknown }> = [];
      const queryBuilder = {
        eq(field: string, value: unknown) {
          filters.push({ field, value });
          return queryBuilder;
        },
      };
      build?.(queryBuilder);

      const filtered = state[table].filter((row) =>
        filters.every((filter) => row[filter.field] === filter.value),
      );

      return {
        unique: async () => clone(filtered[0] ?? null),
        first: async () => clone(filtered[0] ?? null),
        collect: async () => clone(filtered),
      };
    },
    first: async () => clone(state[table][0] ?? null),
    unique: async () => clone(state[table][0] ?? null),
  });

  return {
    db: {
      query(table: TableName) {
        return queryTable(table);
      },
      async insert(table: TableName, value: Record<string, unknown>) {
        const row: Row = {
          _id: `${table}_${nextId++}`,
          ...clone(value),
        };
        state[table].push(row);
        return row._id;
      },
      async patch(id: string, value: Record<string, unknown>) {
        const row = findRow(id);
        if (!row) {
          throw new Error(`Missing row: ${id}`);
        }
        Object.assign(row, clone(value));
      },
      async get(id: string) {
        return clone(findRow(id));
      },
    },
    state,
  };
};

const captureRoutes = async <T>(register: (http: HttpRouter) => void) => {
  const routes: T[] = [];
  const http = {
    route(def: T) {
      routes.push(def);
    },
  } as HttpRouter;
  register(http);
  return routes;
};

/** Convex `Registered*` refs hide `_handler`; tests call it with a fake ctx. */
type InternalMutationHandler = {
  _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
};

async function invokeInternal<T>(
  mutation: unknown,
  ctx: unknown,
  args: Record<string, unknown>,
): Promise<T> {
  return (await (mutation as InternalMutationHandler)._handler(ctx, args)) as T;
}

type DirectHttpAction = (ctx: unknown, request: Request) => Promise<Response>;

describe("managed billing verification", () => {
  const originalFetch = globalThis.fetch;
  const originalServiceCatalog = process.env.STELLA_SERVICE_PRICE_CATALOG_JSON;
  const originalMediaPublicTestMode = process.env.MEDIA_PUBLIC_TEST_MODE;
  const originalFalKey = process.env.FAL_KEY;
  const originalGatewayKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.MEDIA_PUBLIC_TEST_MODE = "1";
    process.env.FAL_KEY = "test-fal-key";
    process.env.OPENROUTER_API_KEY = "test-gateway-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.STELLA_SERVICE_PRICE_CATALOG_JSON = originalServiceCatalog;
    process.env.MEDIA_PUBLIC_TEST_MODE = originalMediaPublicTestMode;
    process.env.FAL_KEY = originalFalKey;
    process.env.OPENROUTER_API_KEY = originalGatewayKey;
  });

  test("persistManagedUsage computes LLM cost from stored managed model prices", async () => {
    const now = Date.now();
    const { db, state } = createMemoryDb({
      billing_model_prices: [{
        _id: "price_1",
        model: "google/gemini-3-flash-preview",
        source: "models.dev",
        sourceProvider: "vercel",
        sourceModelId: "google/gemini-3-flash-preview",
        inputPerMillionUsd: 0.5,
        outputPerMillionUsd: 3,
        cacheReadPerMillionUsd: 0.05,
        cacheWritePerMillionUsd: 0,
        reasoningPerMillionUsd: 0,
        sourceUpdatedAt: "2026-03-16",
        syncedAt: now,
      }],
      conversations: [{
        _id: "conv_default",
        ownerId: "owner_test",
        isDefault: true,
      }],
    });

    const result = await persistManagedUsage(
      { db } as never,
      {
        ownerId: "owner_test",
        agentType: "proxy:general",
        model: "google/gemini-3-flash-preview",
        durationMs: 900,
        success: true,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      },
    );

    const expectedCost = computeUsageCostMicroCents({
      model: "google/gemini-3-flash-preview",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      price: {
        inputPerMillionUsd: 0.5,
        outputPerMillionUsd: 3,
        cacheReadPerMillionUsd: 0.05,
        cacheWritePerMillionUsd: 0,
        reasoningPerMillionUsd: 0,
      },
    });

    expect(result.costMicroCents).toBe(expectedCost);
    expect(state.billing_usage_windows).toHaveLength(1);
    expect(state.billing_usage_windows[0]?.monthlyUsageMicroCents).toBe(expectedCost);
    expect(state.billing_usage_windows[0]?.weeklyUsageMicroCents).toBe(expectedCost);
    expect(state.billing_usage_windows[0]?.rollingUsageMicroCents).toBe(expectedCost);
    expect(state.usage_logs).toHaveLength(1);
    expect(state.usage_logs[0]?.model).toBe("google/gemini-3-flash-preview");
    expect(state.usage_logs[0]?.costMicroCents).toBe(expectedCost);
  });

  test("enforceManagedUsageLimit blocks after the free monthly cap is reached", async () => {
    const now = Date.now();
    const overMonthlyUsd = getPlanConfig("free").monthlyLimitUsd + 1;
    const overMonthlyMicro = dollarsToMicroCents(overMonthlyUsd);
    const { db } = createMemoryDb({
      billing_profiles: [{
        _id: "profile_1",
        ownerId: "owner_limit",
        activePlan: "free",
        subscriptionStatus: "none",
        stripeCustomerId: "",
        stripeSubscriptionId: "",
        stripePriceId: "",
        defaultPaymentMethodId: "",
        paymentMethodBrand: "",
        paymentMethodLast4: "",
        currentPeriodStart: 0,
        currentPeriodEnd: 0,
        cancelAtPeriodEnd: false,
        monthlyAnchorAt: now,
        createdAt: now,
        updatedAt: now,
      }],
      billing_usage_windows: [{
        _id: "usage_1",
        ownerId: "owner_limit",
        rollingUsageMicroCents: 0,
        rollingWindowStartedAt: now,
        weeklyUsageMicroCents: 0,
        weeklyWindowStartedAt: now,
        monthlyUsageMicroCents: overMonthlyMicro,
        monthlyWindowStartedAt: now,
        totalUsageMicroCents: overMonthlyMicro,
        createdAt: now,
        updatedAt: now,
      }],
    });

    const result = await invokeInternal<{
      allowed: boolean;
      plan: string;
      message: string;
      retryAfterMs: number;
    }>(enforceManagedUsageLimit, { db } as never, { ownerId: "owner_limit" });

    expect(result.allowed).toBe(false);
    expect(result.plan).toBe("free");
    expect(result.message).toContain("usage limit reached");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("resolveManagedModelAccess downgrades paid tiers after managed-model limits are reached", async () => {
    const now = Date.now();
    const { db } = createMemoryDb({
      billing_profiles: [{
        _id: "profile_paid",
        ownerId: "owner_paid",
        activePlan: "pro",
        subscriptionStatus: "active",
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        stripePriceId: "price_123",
        defaultPaymentMethodId: "",
        paymentMethodBrand: "",
        paymentMethodLast4: "",
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        cancelAtPeriodEnd: false,
        monthlyAnchorAt: now,
        createdAt: now,
        updatedAt: now,
      }],
      billing_usage_windows: [{
        _id: "usage_paid",
        ownerId: "owner_paid",
        rollingUsageMicroCents: dollarsToMicroCents(61),
        rollingWindowStartedAt: now,
        weeklyUsageMicroCents: dollarsToMicroCents(10),
        weeklyWindowStartedAt: now,
        monthlyUsageMicroCents: dollarsToMicroCents(10),
        monthlyWindowStartedAt: now,
        totalUsageMicroCents: dollarsToMicroCents(61),
        createdAt: now,
        updatedAt: now,
      }],
    });

    const result = await invokeInternal<{
      allowed: boolean;
      plan: string;
      downgraded: boolean;
      modelAudience: string;
      message: string;
    }>(resolveManagedModelAccess, { db } as never, { ownerId: "owner_paid" });

    expect(result.allowed).toBe(true);
    expect(result.plan).toBe("pro");
    expect(result.downgraded).toBe(true);
    expect(result.modelAudience).toBe("pro_fallback");
    expect(result.message).toContain("Falling back");
  });

  test("media generate no longer bills at submission time in public test mode", async () => {
    const { registerMediaRoutes } = await import("../convex/http_routes/media");
    const routes = await captureRoutes<{
      path: string;
      method: string;
      handler: (ctx: unknown, request: Request) => Promise<Response>;
    }>(registerMediaRoutes);
    const generateRoute = routes.find(
      (route) => route.path === "/api/media/v1/generate" && route.method === "POST",
    );

    expect(generateRoute).toBeDefined();

    const scheduled: Array<{ delayMs: number; args: unknown }> = [];
    const runMutationCalls: Array<{ fn: unknown; args: unknown }> = [];
    let mutationCallCount = 0;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          request_id: "fal_req_123",
          status: "IN_QUEUE",
          response_url: "https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra/requests/fal_req_123",
          status_url: "https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra/requests/fal_req_123/status",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const response = await generateRoute!.handler(
      {
        auth: {
          getUserIdentity: async () => null,
        },
        runMutation: async (fn: unknown, args: unknown) => {
          runMutationCalls.push({ fn, args });
          mutationCallCount += 1;
          if (mutationCallCount === 1) {
            return { allowed: true, message: "", retryAfterMs: 0 };
          }
          if (mutationCallCount === 2) {
            return { allowed: true, retryAfterMs: 0 };
          }
          return null;
        },
        scheduler: {
          runAfter: async (delayMs: number, _fn: unknown, args: unknown) => {
            scheduled.push({ delayMs, args });
          },
        },
      },
      new Request("https://example.com/api/media/v1/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          capability: "text_to_image",
          profile: "best",
          prompt: "cinematic rainy Tokyo alley at night",
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(runMutationCalls.length).toBeGreaterThanOrEqual(3);
    expect(scheduled).toHaveLength(0);
    expect(runMutationCalls[0]?.args).toEqual(
      expect.objectContaining({
        ownerId: "__public_media_test__",
        minimumRemainingMicroCents: dollarsToMicroCents(0.8),
      }),
    );
  });

  test("media generate returns 429 when the billing limiter rejects usage", async () => {
    const { registerMediaRoutes } = await import("../convex/http_routes/media");
    const routes = await captureRoutes<{
      path: string;
      method: string;
      handler: (ctx: unknown, request: Request) => Promise<Response>;
    }>(registerMediaRoutes);
    const generateRoute = routes.find(
      (route) => route.path === "/api/media/v1/generate" && route.method === "POST",
    );

    const response = await generateRoute!.handler(
      {
        auth: {
          getUserIdentity: async () => null,
        },
        runMutation: async () => ({
          allowed: false,
          message: "Free plan usage limit reached. Upgrade to continue.",
          retryAfterMs: 60_000,
        }),
        scheduler: {
          runAfter: async () => null,
        },
      },
      new Request("https://example.com/api/media/v1/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          capability: "text_to_image",
          profile: "best",
          prompt: "test prompt",
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("usage limit reached");
  });

  test("media generate redirects realtime requests to the backend realtime session wrapper", async () => {
    const { registerMediaRoutes } = await import("../convex/http_routes/media");
    const routes = await captureRoutes<{
      path: string;
      method: string;
      handler: (ctx: unknown, request: Request) => Promise<Response>;
    }>(registerMediaRoutes);
    const generateRoute = routes.find(
      (route) => route.path === "/api/media/v1/generate" && route.method === "POST",
    );

    const response = await generateRoute!.handler(
      {
        auth: {
          getUserIdentity: async () => null,
        },
        runMutation: async () => ({
          allowed: true,
          message: "",
          retryAfterMs: 0,
        }),
        scheduler: {
          runAfter: async () => null,
        },
      },
      new Request("https://example.com/api/media/v1/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          capability: "realtime",
          profile: "default",
          prompt: "live sketch to watercolor",
          sourceUrl: "https://example.com/source.png",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("/api/media/v1/realtime/session");
  });

  test("media realtime session route tracks backend active seconds for Flux Klein realtime", async () => {
    const { registerMediaRoutes } = await import("../convex/http_routes/media");
    const routes = await captureRoutes<{
      path: string;
      method: string;
      handler: (ctx: unknown, request: Request) => Promise<Response>;
    }>(registerMediaRoutes);
    const sessionRoute = routes.find(
      (route) => route.path === "/api/media/v1/realtime/session" && route.method === "POST",
    );

    expect(sessionRoute).toBeDefined();

    const runMutationCalls: Array<{ fn: unknown; args: unknown }> = [];
    let mutationCallCount = 0;

    const response = await sessionRoute!.handler(
      {
        auth: {
          getUserIdentity: async () => null,
        },
        runMutation: async (fn: unknown, args: unknown) => {
          runMutationCalls.push({ fn, args });
          mutationCallCount += 1;
          if (mutationCallCount === 1) {
            return { allowed: true, message: "", retryAfterMs: 0 };
          }
          if (mutationCallCount === 2) {
            return {
              sessionId: "media_rt_123",
              endpointId: "fal-ai/flux-2/klein/realtime",
              status: "active",
              startedAt: 1_000,
              lastSeenAt: 3_200,
              billedSeconds: 2,
              newlyBilledSeconds: 2,
              costMicroCents: dollarsToMicroCents(0.00388),
            };
          }
          return { allowed: true, message: "", retryAfterMs: 0 };
        },
      },
      new Request("https://example.com/api/media/v1/realtime/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "media_rt_123",
          event: "heartbeat",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(runMutationCalls[1]?.args).toEqual(
      expect.objectContaining({
        ownerId: "__public_media_test__",
        sessionId: "media_rt_123",
        event: "heartbeat",
        endpointId: "fal-ai/flux-2/klein/realtime",
      }),
    );
    expect(await response.json()).toEqual({
      sessionId: "media_rt_123",
      endpointId: "fal-ai/flux-2/klein/realtime",
      status: "active",
      startedAt: 1_000,
      lastSeenAt: 3_200,
      billedSeconds: 2,
      newlyBilledSeconds: 2,
      costMicroCents: dollarsToMicroCents(0.00388),
      shouldStop: false,
    });
  });

  test("media realtime session route rejects heartbeats for missing sessions", async () => {
    const { registerMediaRoutes } = await import("../convex/http_routes/media");
    const routes = await captureRoutes<{
      path: string;
      method: string;
      handler: (ctx: unknown, request: Request) => Promise<Response>;
    }>(registerMediaRoutes);
    const sessionRoute = routes.find(
      (route) => route.path === "/api/media/v1/realtime/session" && route.method === "POST",
    );

    const response = await sessionRoute!.handler(
      {
        auth: {
          getUserIdentity: async () => null,
        },
        runMutation: async (_fn: unknown, args: unknown) => {
          if ((args as { scope?: string }).scope === "media_realtime_session") {
            return { allowed: true, retryAfterMs: 0 };
          }
          throw new ConvexError({
            code: "NOT_FOUND",
            message: "Realtime media session not found. Start a session before sending heartbeats.",
          });
        },
      },
      new Request("https://example.com/api/media/v1/realtime/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "media_rt_missing",
          event: "heartbeat",
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Start a session before sending heartbeats");
  });

  test("media realtime session route expires late heartbeats and requires restart", async () => {
    const { registerMediaRoutes } = await import("../convex/http_routes/media");
    const routes = await captureRoutes<{
      path: string;
      method: string;
      handler: (ctx: unknown, request: Request) => Promise<Response>;
    }>(registerMediaRoutes);
    const sessionRoute = routes.find(
      (route) => route.path === "/api/media/v1/realtime/session" && route.method === "POST",
    );

    let mutationCallCount = 0;

    const response = await sessionRoute!.handler(
      {
        auth: {
          getUserIdentity: async () => null,
        },
        runMutation: async (_fn: unknown, args: unknown) => {
          mutationCallCount += 1;
          if (mutationCallCount === 1) {
            return { allowed: true, retryAfterMs: 0 };
          }
          if (mutationCallCount === 2) {
            return {
              sessionId: "media_rt_123",
              endpointId: "fal-ai/flux-2/klein/realtime",
              status: "ended",
              startedAt: 1_000,
              lastSeenAt: 16_000,
              billedSeconds: 15,
              newlyBilledSeconds: 12,
              costMicroCents: dollarsToMicroCents(0.02328),
              expired: true,
            };
          }
          return { allowed: true, message: "", retryAfterMs: 0 };
        },
      },
      new Request("https://example.com/api/media/v1/realtime/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "media_rt_123",
          event: "heartbeat",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      sessionId: "media_rt_123",
      endpointId: "fal-ai/flux-2/klein/realtime",
      status: "ended",
      startedAt: 1_000,
      lastSeenAt: 16_000,
      billedSeconds: 15,
      newlyBilledSeconds: 12,
      costMicroCents: dollarsToMicroCents(0.02328),
      expired: true,
      shouldStop: true,
      stopReason: "Realtime media session expired after 15 seconds without a heartbeat. Start a new session.",
    });
  });

  test("media webhook schedules actual endpoint billing on completion", async () => {
    const { registerMediaRoutes } = await import("../convex/http_routes/media");
    const routes = await captureRoutes<{
      path: string;
      method: string;
      handler: (ctx: unknown, request: Request) => Promise<Response>;
    }>(registerMediaRoutes);
    const webhookRoute = routes.find(
      (route) => route.path === "/api/media/v1/webhooks/fal" && route.method === "POST",
    );

    expect(webhookRoute).toBeDefined();

    const scheduled: Array<{ delayMs: number; args: unknown }> = [];

    const response = await webhookRoute!.handler(
      {
        runMutation: async () => ({
          allowed: true,
          retryAfterMs: 0,
        }),
        runQuery: async () => ({
          ownerId: "__public_media_test__",
          endpointId: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
          request: {
            prompt: "cinematic rainy Tokyo alley at night",
            input: {
              prompt: "cinematic rainy Tokyo alley at night",
              num_images: 2,
            },
          },
          providerResponseUrl: "https://queue.fal.run/fal-ai/bytedance/seedream/v5/lite/text-to-image/requests/fal_req_123",
        }),
        scheduler: {
          runAfter: async (delayMs: number, _fn: unknown, args: unknown) => {
            scheduled.push({ delayMs, args });
          },
        },
      },
      new Request("https://example.com/api/media/v1/webhooks/fal?jobId=job_123", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-stella-test-webhook": "1",
        },
        body: JSON.stringify({
          request_id: "fal_req_123",
          status: "OK",
          payload: {
            images: [{ url: "https://example.com/generated-image.png" }],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]?.args).toEqual(
      expect.objectContaining({
        jobId: "job_123",
        billing: expect.objectContaining({
          endpointId: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
          costMicroCents: dollarsToMicroCents(0.07),
        }),
      }),
    );
    expect(scheduled[1]?.args).toEqual(
      expect.objectContaining({
        ownerId: "__public_media_test__",
        jobId: "job_123",
        endpointId: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
        costMicroCents: dollarsToMicroCents(0.07),
        billingUnit: "image",
        quantity: 2,
      }),
    );
  });

  test("stella provider schedules token usage for billing on successful responses", async () => {
    const scheduled: Array<{ delayMs: number; args: unknown }> = [];
    let mutationCallCount = 0;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 45,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const response = await (
      stellaProviderChatCompletions as unknown as DirectHttpAction
    )(
      {
        auth: {
          getUserIdentity: async () => ({
            subject: "owner_llm",
            isAnonymous: false,
          }),
        },
        runMutation: async () => {
          mutationCallCount += 1;
            if (mutationCallCount === 1) {
              return {
                allowed: true,
                downgraded: false,
                modelAudience: "free",
                plan: "free",
                retryAfterMs: 0,
                message: "",
                tokensPerMinute: getPlanConfig("free").tokensPerMinute,
            };
          }
          if (mutationCallCount === 2) {
            return {
              allowed: true,
              retryAfterMs: 0,
            };
          }
          throw new Error("Unexpected mutation");
        },
        scheduler: {
          runAfter: async (delayMs: number, _fn: unknown, args: unknown) => {
            scheduled.push({ delayMs, args });
          },
        },
      } as never,
      new Request("https://example.com/api/stella/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stella-Agent-Type": "general",
        },
        body: JSON.stringify({
          model: "stella/default",
          messages: [{ role: "user", content: "Hello there" }],
          max_completion_tokens: 300,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.args).toEqual(
        expect.objectContaining({
          ownerId: "owner_llm",
          agentType: "general",
          model: getModelConfig("general", "free").model,
          inputTokens: 120,
          outputTokens: 45,
          success: true,
          durationMs: expect.any(Number),
        }),
      );
    });

    test("stella provider uses fallback tier models after a paid plan exhausts managed-model limits", async () => {
      const originalFallbackModel = AUDIENCE_AGENT_MODELS.plus_fallback.general.model;
      AUDIENCE_AGENT_MODELS.plus_fallback.general.model = "anthropic/claude-sonnet-4.6";
      globalThis.fetch = async (_url, init) => {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return new Response(
          JSON.stringify({
            requestedModel: parsed.model,
            usage: {
              prompt_tokens: 20,
              completion_tokens: 10,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const response = await (
        stellaProviderChatCompletions as unknown as DirectHttpAction
      )(
        {
          auth: {
            getUserIdentity: async () => ({
              subject: "owner_paid_fallback",
              isAnonymous: false,
            }),
          },
          runMutation: async () => ({
            allowed: true,
            downgraded: true,
            modelAudience: "plus_fallback",
            plan: "plus",
            retryAfterMs: 60_000,
            message: "Plus plan managed-model limits reached. Falling back until usage resets.",
            tokensPerMinute: 500_000,
          }),
          scheduler: {
            runAfter: async () => null,
          },
        } as never,
        new Request("https://example.com/api/stella/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Stella-Agent-Type": "general",
          },
          body: JSON.stringify({
            model: "stella/default",
            messages: [{ role: "user", content: "Hello there" }],
          }),
        }),
      );

      try {
        expect(response.status).toBe(200);
        const payload = await response.json() as { requestedModel?: string };
        expect(payload.requestedModel).toBe("anthropic/claude-sonnet-4.6");
      } finally {
        AUDIENCE_AGENT_MODELS.plus_fallback.general.model = originalFallbackModel;
      }
    });

  test("recordVoiceRealtimeUsage deduplicates response IDs and stores the billed cost", async () => {
    const { db, state } = createMemoryDb({
      conversations: [{
        _id: "conv_voice",
        ownerId: "owner_voice",
        isDefault: true,
      }],
    });

    const first = await invokeInternal<{
      recorded: boolean;
      duplicate: boolean;
      costMicroCents: number;
    }>(recordVoiceRealtimeUsage, { db } as never, {
      ownerId: "owner_voice",
      responseId: "resp_123",
      model: "gpt-realtime-1.5",
      conversationId: "conv_voice" as never,
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      textInputTokens: 100,
      textCachedInputTokens: 20,
      textOutputTokens: 50,
      audioInputTokens: 150,
      audioCachedInputTokens: 10,
      audioOutputTokens: 100,
      imageInputTokens: 30,
      imageCachedInputTokens: 0,
    });

    const second = await invokeInternal<{
      recorded: boolean;
      duplicate: boolean;
      costMicroCents: number;
    }>(recordVoiceRealtimeUsage, { db } as never, {
      ownerId: "owner_voice",
      responseId: "resp_123",
      model: "gpt-realtime-1.5",
      conversationId: "conv_voice" as never,
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      textInputTokens: 100,
      textCachedInputTokens: 20,
      textOutputTokens: 50,
      audioInputTokens: 150,
      audioCachedInputTokens: 10,
      audioOutputTokens: 100,
      imageInputTokens: 30,
      imageCachedInputTokens: 0,
    });

    expect(first.recorded).toBe(true);
    expect(first.costMicroCents).toBeGreaterThan(0);
    expect(second.recorded).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(state.billing_voice_usage_receipts).toHaveLength(1);
    expect(state.usage_logs).toHaveLength(1);
    expect(state.usage_logs[0]?.model).toBe("gpt-realtime-1.5");
    expect(state.usage_logs[0]?.costMicroCents).toBe(first.costMicroCents);
  });

  test("recordMediaCompletedUsage deduplicates media jobs and stores the billed cost", async () => {
    const { db, state } = createMemoryDb({
      conversations: [{
        _id: "conv_media",
        ownerId: "owner_media",
        isDefault: true,
      }],
    });

    const first = await invokeInternal<{
      recorded: boolean;
      duplicate: boolean;
    }>(recordMediaCompletedUsage, { db } as never, {
      ownerId: "owner_media",
      jobId: "job_media_1",
      providerRequestId: "fal_req_123",
      endpointId: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
      billingUnit: "image",
      quantity: 2,
      costMicroCents: dollarsToMicroCents(0.07),
    });

    const second = await invokeInternal<{
      recorded: boolean;
      duplicate: boolean;
    }>(recordMediaCompletedUsage, { db } as never, {
      ownerId: "owner_media",
      jobId: "job_media_1",
      providerRequestId: "fal_req_123",
      endpointId: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
      billingUnit: "image",
      quantity: 2,
      costMicroCents: dollarsToMicroCents(0.07),
    });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(state.billing_media_usage_receipts).toHaveLength(1);
    expect(state.usage_logs).toHaveLength(1);
    expect(state.usage_logs[0]?.model).toBe("fal-ai/bytedance/seedream/v5/lite/text-to-image");
  });

  test("syncSessionActivity bills newly elapsed realtime seconds only once", async () => {
    const now = Date.now();
    const { db, state } = createMemoryDb({
      conversations: [{
        _id: "conv_rt",
        ownerId: "owner_rt",
        isDefault: true,
      }],
    });

    const started = await invokeInternal<{ newlyBilledSeconds: number }>(
      syncSessionActivity,
      { db } as never,
      {
        ownerId: "owner_rt",
        sessionId: "media_rt_1",
        event: "start",
        observedAt: now,
      },
    );

    const heartbeated = await invokeInternal<{ newlyBilledSeconds: number }>(
      syncSessionActivity,
      { db } as never,
      {
        ownerId: "owner_rt",
        sessionId: "media_rt_1",
        event: "heartbeat",
        observedAt: now + 3_400,
      },
    );

    const stopped = await invokeInternal<{ newlyBilledSeconds: number }>(
      syncSessionActivity,
      { db } as never,
      {
        ownerId: "owner_rt",
        sessionId: "media_rt_1",
        event: "stop",
        observedAt: now + 3_900,
      },
    );

    expect(started.newlyBilledSeconds).toBe(0);
    expect(heartbeated.newlyBilledSeconds).toBe(3);
    expect(stopped.newlyBilledSeconds).toBe(0);
    expect(state.media_realtime_sessions).toHaveLength(1);
    expect(state.media_realtime_sessions[0]?.billedSeconds).toBe(3);
    expect(state.media_realtime_sessions[0]?.status).toBe("ended");
    expect(state.usage_logs).toHaveLength(1);
    expect(state.usage_logs[0]?.model).toBe("fal-ai/flux-2/klein/realtime");
    expect(state.usage_logs[0]?.costMicroCents).toBe(dollarsToMicroCents(0.00582));
  });

  test("syncSessionActivity clips missed heartbeat billing at the timeout boundary", async () => {
    const now = Date.now();
    const { db, state } = createMemoryDb({
      conversations: [{
        _id: "conv_rt_timeout",
        ownerId: "owner_rt_timeout",
        isDefault: true,
      }],
    });

    await invokeInternal<unknown>(syncSessionActivity, { db } as never, {
      ownerId: "owner_rt_timeout",
      sessionId: "media_rt_timeout",
      event: "start",
      observedAt: now,
    });

    const expired = await invokeInternal<{
      status: string;
      expired: boolean;
      billedSeconds: number;
    }>(syncSessionActivity, { db } as never, {
      ownerId: "owner_rt_timeout",
      sessionId: "media_rt_timeout",
      event: "heartbeat",
      observedAt: now + 30_000,
    });

    expect(expired.status).toBe("ended");
    expect(expired.expired).toBe(true);
    expect(expired.billedSeconds).toBe(15);
    expect(state.usage_logs).toHaveLength(1);
    expect(state.usage_logs[0]?.costMicroCents).toBe(dollarsToMicroCents(0.0291));
  });
});
