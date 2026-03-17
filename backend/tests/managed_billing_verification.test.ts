import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { internal } from "../convex/_generated/api";
import {
  enforceManagedUsageLimit,
  persistManagedUsage,
  recordVoiceRealtimeUsage,
} from "../convex/billing";
import {
  computeServiceCostMicroCents,
  computeUsageCostMicroCents,
  dollarsToMicroCents,
} from "../convex/lib/billing_money";
import { stellaProviderChatCompletions } from "../convex/stella_provider";

type TableName =
  | "billing_profiles"
  | "billing_usage_windows"
  | "billing_model_prices"
  | "billing_voice_usage_receipts"
  | "conversations"
  | "usage_logs";

type Row = Record<string, unknown> & { _id: string };

type MemoryState = Record<TableName, Row[]>;

const makeState = (): MemoryState => ({
  billing_profiles: [],
  billing_usage_windows: [],
  billing_model_prices: [],
  billing_voice_usage_receipts: [],
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

const captureRoutes = async <T>(register: (http: { route: (def: T) => void }) => void) => {
  const routes: T[] = [];
  register({
    route(def: T) {
      routes.push(def);
    },
  });
  return routes;
};

describe("managed billing verification", () => {
  const originalFetch = globalThis.fetch;
  const originalServiceCatalog = process.env.STELLA_SERVICE_PRICE_CATALOG_JSON;
  const originalMediaPublicTestMode = process.env.MEDIA_PUBLIC_TEST_MODE;
  const originalFalKey = process.env.FAL_KEY;
  const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(() => {
    process.env.MEDIA_PUBLIC_TEST_MODE = "1";
    process.env.FAL_KEY = "test-fal-key";
    process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.STELLA_SERVICE_PRICE_CATALOG_JSON = originalServiceCatalog;
    process.env.MEDIA_PUBLIC_TEST_MODE = originalMediaPublicTestMode;
    process.env.FAL_KEY = originalFalKey;
    process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
  });

  test("persistManagedUsage computes LLM cost from stored managed model prices", async () => {
    const now = Date.now();
    const { db, state } = createMemoryDb({
      billing_model_prices: [{
        _id: "price_1",
        model: "google/gemini-3-flash",
        source: "models.dev",
        sourceProvider: "vercel",
        sourceModelId: "google/gemini-3-flash",
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
        model: "google/gemini-3-flash",
        durationMs: 900,
        success: true,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      },
    );

    const expectedCost = computeUsageCostMicroCents({
      model: "google/gemini-3-flash",
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
    expect(state.usage_logs[0]?.model).toBe("google/gemini-3-flash");
    expect(state.usage_logs[0]?.costMicroCents).toBe(expectedCost);
  });

  test("enforceManagedUsageLimit blocks after the free monthly cap is reached", async () => {
    const now = Date.now();
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
        monthlyUsageMicroCents: dollarsToMicroCents(15),
        monthlyWindowStartedAt: now,
        totalUsageMicroCents: dollarsToMicroCents(15),
        createdAt: now,
        updatedAt: now,
      }],
    });

    const result = await enforceManagedUsageLimit._handler(
      { db } as never,
      { ownerId: "owner_limit" },
    );

    expect(result.allowed).toBe(false);
    expect(result.plan).toBe("free");
    expect(result.message).toContain("usage limit reached");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("media generate logs the built-in media default cost in public test mode", async () => {
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
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(0);
    expect(scheduled[0]?.args).toEqual(
      expect.objectContaining({
        ownerId: "__public_media_test__",
        agentType: "service:media",
        model: "media:text_to_image:best",
        success: true,
        costMicroCents: computeServiceCostMicroCents("media:text_to_image:best"),
      }),
    );
    expect(computeServiceCostMicroCents("media:text_to_image:best")).toBe(
      dollarsToMicroCents(0.035),
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

    const response = await stellaProviderChatCompletions(
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
              retryAfterMs: 0,
              message: "",
              tokensPerMinute: 150_000,
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
        model: "moonshotai/kimi-k2.5",
        inputTokens: 120,
        outputTokens: 45,
        success: true,
      }),
    );
  });

  test("recordVoiceRealtimeUsage deduplicates response IDs and stores the billed cost", async () => {
    const { db, state } = createMemoryDb({
      conversations: [{
        _id: "conv_voice",
        ownerId: "owner_voice",
        isDefault: true,
      }],
    });

    const first = await recordVoiceRealtimeUsage._handler(
      { db } as never,
      {
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
      },
    );

    const second = await recordVoiceRealtimeUsage._handler(
      { db } as never,
      {
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
      },
    );

    expect(first.recorded).toBe(true);
    expect(first.costMicroCents).toBeGreaterThan(0);
    expect(second.recorded).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(state.billing_voice_usage_receipts).toHaveLength(1);
    expect(state.usage_logs).toHaveLength(1);
    expect(state.usage_logs[0]?.model).toBe("gpt-realtime-1.5");
    expect(state.usage_logs[0]?.costMicroCents).toBe(first.costMicroCents);
  });
});
