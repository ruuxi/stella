import { ConvexError } from "convex/values";
import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import {
  AGENT_IDS,
  LOCAL_RUNTIME_BACKEND_TOOL_NAMES,
} from "../lib/agent_constants";
import {
  enforceActionRateLimit,
  RATE_EXPENSIVE,
  RATE_STANDARD,
} from "../lib/rate_limits";
import { createBackendTools, executeWebSearch } from "../tools/backend";
import { jsonValueValidator } from "../shared_validators";
import {
  buildCartPermalink,
  cancelCheckout,
  createCheckout,
  debugSearchGlobalProducts,
  discoverCheckoutEndpoint,
  getGlobalProductDetails,
  searchGlobalProducts,
  updateCheckout,
} from "../lib/shopify_ucp";

const DEFAULT_MAX_AGENT_DEPTH = 2;
const ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS = new Set<string>(
  LOCAL_RUNTIME_BACKEND_TOOL_NAMES,
);

const toToolResultText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

const executeBackendTool = async (
  ctx: Parameters<typeof createBackendTools>[0],
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    agentType?: string;
  },
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<string> => {
  if (!ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS.has(toolName)) {
    throw new ConvexError(`Tool ${toolName} is not allowed from local runtime`);
  }
  const tools = createBackendTools(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    agentType: args.agentType ?? AGENT_IDS.GENERAL,
    maxAgentDepth: DEFAULT_MAX_AGENT_DEPTH,
  }) as Record<
    string,
    { execute?: (input: Record<string, unknown>) => Promise<unknown> }
  >;

  const tool = tools[toolName];
  if (!tool?.execute) {
    throw new ConvexError(`${toolName} is unavailable`);
  }

  const output = await tool.execute(toolArgs);
  return toToolResultText(output);
};

export const executeTool = action({
  args: {
    toolName: v.string(),
    toolArgs: v.optional(jsonValueValidator),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "agent_local_runtime_execute_tool",
      ownerId,
      RATE_STANDARD,
      "Too many tool invocations. Please wait a moment and try again.",
    );
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }

    const toolArgs =
      args.toolArgs && typeof args.toolArgs === "object"
        ? (args.toolArgs as Record<string, unknown>)
        : {};

    return await executeBackendTool(
      ctx,
      {
        ownerId,
        conversationId: args.conversationId,
        agentType: args.agentType,
      },
      args.toolName,
      toolArgs,
    );
  },
});

export const webSearch = action({
  args: {
    query: v.string(),
    category: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
  },
  returns: v.object({
    text: v.string(),
    results: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        snippet: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    // Outbound HTTP on the user's behalf — without a cap, the backend
    // becomes a free crawler.
    await enforceActionRateLimit(
      ctx,
      "agent_local_runtime_web_search",
      ownerId,
      RATE_EXPENSIVE,
      "Too many web searches. Please wait a moment and try again.",
    );
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }
    return await executeWebSearch(ctx, args.query, {
      ownerId,
      category: args.category,
    });
  },
});

// ---------------------------------------------------------------------------
// Fashion + Shopify UCP actions.
//
// Surfaced to the desktop runtime so the Fashion subagent can:
//   - search the global Shopify catalog (`shopifySearchProducts`)
//   - fetch product details when a model needs richer metadata
//   - render the user wearing those clothes via `image_gen` (handled in the
//     runtime, not here — this file only owns Shopify HTTP plumbing)
//   - record completed outfits (`fashionRecordOutfit`) so the Fashion tab
//     surfaces them reactively
//   - open / continue / cancel a Checkout MCP session, with a graceful
//     cart-permalink fallback when the merchant doesn't expose Checkout MCP
// ---------------------------------------------------------------------------

const shopifySearchProductValidator = v.object({
  productId: v.string(),
  variantId: v.string(),
  title: v.string(),
  vendor: v.optional(v.string()),
  description: v.optional(v.string()),
  price: v.optional(v.number()),
  currency: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  productUrl: v.optional(v.string()),
  checkoutUrl: v.optional(v.string()),
  merchantOrigin: v.string(),
});

export const shopifySearchProducts = action({
  args: {
    query: v.string(),
    context: v.optional(v.string()),
    limit: v.optional(v.number()),
    savedCatalog: v.optional(v.string()),
  },
  returns: v.array(shopifySearchProductValidator),
  handler: async (_ctx, args) => {
    return await searchGlobalProducts({
      query: args.query,
      ...(args.context !== undefined ? { context: args.context } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.savedCatalog !== undefined ? { savedCatalog: args.savedCatalog } : {}),
    });
  },
});

export const shopifyDebugSearchProducts = action({
  args: {
    query: v.string(),
    context: v.optional(v.string()),
    limit: v.optional(v.number()),
    savedCatalog: v.optional(v.string()),
  },
  returns: jsonValueValidator,
  handler: async (_ctx, args) => {
    return await debugSearchGlobalProducts({
      query: args.query,
      ...(args.context !== undefined ? { context: args.context } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.savedCatalog !== undefined ? { savedCatalog: args.savedCatalog } : {}),
    });
  },
});

export const shopifyGetProductDetails = action({
  args: { productId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      productId: v.string(),
      variantId: v.string(),
      title: v.string(),
      vendor: v.optional(v.string()),
      description: v.optional(v.string()),
      price: v.optional(v.number()),
      currency: v.optional(v.string()),
      imageUrl: v.optional(v.string()),
      productUrl: v.optional(v.string()),
      checkoutUrl: v.optional(v.string()),
      merchantOrigin: v.string(),
      variants: v.optional(
        v.array(
          v.object({
            variantId: v.string(),
            title: v.optional(v.string()),
            price: v.optional(v.number()),
            currency: v.optional(v.string()),
            available: v.optional(v.boolean()),
            options: v.optional(v.record(v.string(), v.string())),
          }),
        ),
      ),
    }),
  ),
  handler: async (_ctx, args) => {
    return await getGlobalProductDetails({ productId: args.productId });
  },
});

const checkoutLineValidator = v.object({
  variantId: v.string(),
  quantity: v.number(),
});

const checkoutSessionResultValidator = v.object({
  checkoutId: v.string(),
  status: v.string(),
  continueUrl: v.optional(v.string()),
  merchantOrigin: v.string(),
  mcpEndpoint: v.string(),
  /** When `false`, the upstream did not expose Checkout MCP and we returned a cart-permalink only. */
  usingMcp: v.boolean(),
  /** When `usingMcp` is false this carries the cart permalink we opened instead. */
  cartUrl: v.optional(v.string()),
});

export const shopifyCreateCheckout = action({
  args: {
    merchantOrigin: v.string(),
    lines: v.array(checkoutLineValidator),
  },
  returns: checkoutSessionResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "fashion_shopify_create_checkout",
      ownerId,
      RATE_STANDARD,
      "Too many checkout attempts. Wait a moment and try again.",
    );
    if (!args.lines.length) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "At least one line item is required.",
      });
    }

    const descriptor = await discoverCheckoutEndpoint({
      merchantOrigin: args.merchantOrigin,
    });
    if (!descriptor) {
      const cartUrl = buildCartPermalink({
        merchantOrigin: args.merchantOrigin,
        lines: args.lines,
      });
      if (!cartUrl) {
        throw new ConvexError({
          code: "FAILED_PRECONDITION",
          message:
            "Merchant does not expose Checkout MCP and we could not build a cart permalink.",
        });
      }
      return {
        checkoutId: cartUrl,
        status: "permalink",
        continueUrl: cartUrl,
        merchantOrigin: args.merchantOrigin,
        mcpEndpoint: "",
        usingMcp: false,
        cartUrl,
      };
    }

    const session = await createCheckout({
      endpoint: descriptor.endpoint,
      lines: args.lines,
    });
    await ctx.runMutation(internal.data.fashion.recordCheckoutSession, {
      ownerId,
      merchantOrigin: descriptor.merchantOrigin,
      mcpEndpoint: descriptor.endpoint,
      checkoutId: session.checkoutId,
      status: session.status,
      ...(session.continueUrl ? { continueUrl: session.continueUrl } : {}),
      rawResponse: JSON.stringify(session.raw).slice(0, 60_000),
    });
    return {
      checkoutId: session.checkoutId,
      status: session.status,
      ...(session.continueUrl ? { continueUrl: session.continueUrl } : {}),
      merchantOrigin: descriptor.merchantOrigin,
      mcpEndpoint: descriptor.endpoint,
      usingMcp: true,
    };
  },
});

export const shopifyUpdateCheckout = action({
  args: {
    mcpEndpoint: v.string(),
    checkoutId: v.string(),
    lines: v.array(checkoutLineValidator),
  },
  returns: checkoutSessionResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "fashion_shopify_update_checkout",
      ownerId,
      RATE_STANDARD,
      "Too many checkout updates. Wait a moment and try again.",
    );
    const session = await updateCheckout({
      endpoint: args.mcpEndpoint,
      checkoutId: args.checkoutId,
      lines: args.lines,
    });
    return {
      checkoutId: session.checkoutId,
      status: session.status,
      ...(session.continueUrl ? { continueUrl: session.continueUrl } : {}),
      merchantOrigin: "",
      mcpEndpoint: args.mcpEndpoint,
      usingMcp: true,
    };
  },
});

export const shopifyCancelCheckout = action({
  args: {
    mcpEndpoint: v.string(),
    checkoutId: v.string(),
  },
  returns: v.object({
    checkoutId: v.string(),
    status: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "fashion_shopify_cancel_checkout",
      ownerId,
      RATE_STANDARD,
      "Too many checkout cancels. Wait a moment and try again.",
    );
    return await cancelCheckout({
      endpoint: args.mcpEndpoint,
      checkoutId: args.checkoutId,
    });
  },
});

const outfitProductInputValidator = v.object({
  slot: v.string(),
  productId: v.string(),
  variantId: v.string(),
  title: v.string(),
  price: v.optional(v.number()),
  currency: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  productUrl: v.optional(v.string()),
  checkoutUrl: v.optional(v.string()),
  vendor: v.optional(v.string()),
  merchantOrigin: v.string(),
});

/**
 * Reserve an outfit row in `fashion_outfits` (status `generating`). The
 * runtime then calls `image_gen` for the try-on render and follows up with
 * `fashionMarkOutfitReady` / `fashionMarkOutfitFailed`. Splitting the create
 * vs. ready/failed paths lets the desktop UI render a placeholder card that
 * crossfades into the rendered look the moment the image lands.
 */
export const fashionRegisterOutfit = action({
  args: {
    batchId: v.string(),
    ordinal: v.number(),
    themeLabel: v.string(),
    themeDescription: v.optional(v.string()),
    stylePrompt: v.optional(v.string()),
    products: v.array(outfitProductInputValidator),
    tryOnPrompt: v.optional(v.string()),
  },
  returns: v.id("fashion_outfits"),
  handler: async (ctx, args): Promise<Id<"fashion_outfits">> => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "fashion_register_outfit",
      ownerId,
      RATE_STANDARD,
      "Too many outfit registrations. Wait a moment and try again.",
    );
    return await ctx.runMutation(internal.data.fashion.insertOutfit, {
      ownerId,
      batchId: args.batchId,
      ordinal: args.ordinal,
      themeLabel: args.themeLabel,
      ...(args.themeDescription !== undefined
        ? { themeDescription: args.themeDescription }
        : {}),
      ...(args.stylePrompt !== undefined ? { stylePrompt: args.stylePrompt } : {}),
      products: args.products,
      ...(args.tryOnPrompt !== undefined ? { tryOnPrompt: args.tryOnPrompt } : {}),
    });
  },
});

export const fashionMarkOutfitReady = action({
  args: {
    outfitId: v.id("fashion_outfits"),
    tryOnImagePath: v.optional(v.string()),
    tryOnImageUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "fashion_mark_outfit_ready",
      ownerId,
      RATE_STANDARD,
    );
    await ctx.runMutation(internal.data.fashion.markOutfitReady, {
      ownerId,
      outfitId: args.outfitId,
      ...(args.tryOnImagePath !== undefined
        ? { tryOnImagePath: args.tryOnImagePath }
        : {}),
      ...(args.tryOnImageUrl !== undefined
        ? { tryOnImageUrl: args.tryOnImageUrl }
        : {}),
    });
    return null;
  },
});

export const fashionMarkOutfitFailed = action({
  args: {
    outfitId: v.id("fashion_outfits"),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "fashion_mark_outfit_failed",
      ownerId,
      RATE_STANDARD,
    );
    await ctx.runMutation(internal.data.fashion.markOutfitFailed, {
      ownerId,
      outfitId: args.outfitId,
      errorMessage: args.errorMessage,
    });
    return null;
  },
});

export const fashionGetOrchestratorContext = action({
  args: {},
  returns: v.object({
    profile: v.union(
      v.null(),
      v.object({
        sizes: v.optional(v.record(v.string(), v.string())),
        stylePreferences: v.optional(v.string()),
      }),
    ),
    recentLikes: v.array(
      v.object({
        productId: v.string(),
        title: v.string(),
        vendor: v.optional(v.string()),
      }),
    ),
    cart: v.array(
      v.object({
        productId: v.string(),
        title: v.string(),
        quantity: v.number(),
      }),
    ),
    recentOutfitProductIds: v.array(v.string()),
  }),
  handler: async (ctx): Promise<{
    profile: { sizes?: Record<string, string>; stylePreferences?: string } | null;
    recentLikes: Array<{ productId: string; title: string; vendor?: string }>;
    cart: Array<{ productId: string; title: string; quantity: number }>;
    recentOutfitProductIds: string[];
  }> => {
    const ownerId = await requireUserId(ctx);
    return await ctx.runQuery(
      internal.data.fashion.getOrchestratorContextInternal,
      { ownerId },
    );
  },
});
