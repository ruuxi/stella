/**
 * Wires the Fashion subagent's `FashionToolApi` to the Convex actions
 * defined in `backend/convex/agent/local_runtime.ts`. Each method just
 * forwards to one Convex action; the backend owns auth, rate limits,
 * and Shopify HTTP plumbing.
 *
 * The wiring is built once at runtime startup; the actual Convex client
 * is resolved lazily inside `convexAction` so this works the same way
 * `queryConvex` does (the client may not exist yet when the host is
 * constructed).
 */

import type {
  FashionContextSummary,
  FashionShopProduct,
  FashionShopProductDetail,
  FashionToolApi,
} from "../tools/types.js";

type ConvexAction = (ref: unknown, args: unknown) => Promise<unknown>;

type ConvexActionRefs = {
  search: unknown;
  getDetails: unknown;
  registerOutfit: unknown;
  markReady: unknown;
  markFailed: unknown;
  createCheckout: unknown;
  cancelCheckout: unknown;
  getContext: unknown;
};

const resolveActionRefs = (convexApi: unknown): ConvexActionRefs => {
  const root = convexApi as {
    agent: {
      local_runtime: {
        shopifySearchProducts: unknown;
        shopifyGetProductDetails: unknown;
        fashionRegisterOutfit: unknown;
        fashionMarkOutfitReady: unknown;
        fashionMarkOutfitFailed: unknown;
        shopifyCreateCheckout: unknown;
        shopifyCancelCheckout: unknown;
        fashionGetOrchestratorContext: unknown;
      };
    };
  };
  const ns = root.agent.local_runtime;
  return {
    search: ns.shopifySearchProducts,
    getDetails: ns.shopifyGetProductDetails,
    registerOutfit: ns.fashionRegisterOutfit,
    markReady: ns.fashionMarkOutfitReady,
    markFailed: ns.fashionMarkOutfitFailed,
    createCheckout: ns.shopifyCreateCheckout,
    cancelCheckout: ns.shopifyCancelCheckout,
    getContext: ns.fashionGetOrchestratorContext,
  };
};

export const createFashionApi = (deps: {
  convexAction: ConvexAction;
  convexApi: unknown;
}): FashionToolApi => {
  const refs = resolveActionRefs(deps.convexApi);

  return {
    getOrchestratorContext: async (): Promise<FashionContextSummary> => {
      const result = (await deps.convexAction(
        refs.getContext,
        {},
      )) as FashionContextSummary;
      return result;
    },
    searchProducts: async (args) => {
      const result = (await deps.convexAction(refs.search, {
        query: args.query,
        ...(args.context !== undefined ? { context: args.context } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.savedCatalog !== undefined
          ? { savedCatalog: args.savedCatalog }
          : {}),
      })) as FashionShopProduct[];
      return result;
    },
    getProductDetails: async (args) => {
      const result = (await deps.convexAction(refs.getDetails, {
        productId: args.productId,
      })) as FashionShopProductDetail | null;
      return result;
    },
    registerOutfit: async (args) => {
      const result = (await deps.convexAction(refs.registerOutfit, {
        batchId: args.batchId,
        ordinal: args.ordinal,
        themeLabel: args.themeLabel,
        ...(args.themeDescription !== undefined
          ? { themeDescription: args.themeDescription }
          : {}),
        ...(args.stylePrompt !== undefined
          ? { stylePrompt: args.stylePrompt }
          : {}),
        products: args.products,
        ...(args.tryOnPrompt !== undefined
          ? { tryOnPrompt: args.tryOnPrompt }
          : {}),
      })) as string;
      return result;
    },
    markOutfitReady: async (args) => {
      await deps.convexAction(refs.markReady, {
        outfitId: args.outfitId,
        ...(args.tryOnImagePath !== undefined
          ? { tryOnImagePath: args.tryOnImagePath }
          : {}),
        ...(args.tryOnImageUrl !== undefined
          ? { tryOnImageUrl: args.tryOnImageUrl }
          : {}),
      });
    },
    markOutfitFailed: async (args) => {
      await deps.convexAction(refs.markFailed, {
        outfitId: args.outfitId,
        errorMessage: args.errorMessage,
      });
    },
    createCheckout: async (args) => {
      const result = (await deps.convexAction(refs.createCheckout, {
        merchantOrigin: args.merchantOrigin,
        lines: args.lines,
      })) as Awaited<ReturnType<FashionToolApi["createCheckout"]>>;
      return result;
    },
    cancelCheckout: async (args) => {
      const result = (await deps.convexAction(refs.cancelCheckout, {
        mcpEndpoint: args.mcpEndpoint,
        checkoutId: args.checkoutId,
      })) as { checkoutId: string; status: string };
      return result;
    },
  };
};
