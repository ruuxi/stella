/**
 * Fashion subagent surface — UCP catalog search, outfit registration, and
 * try-on lifecycle. The orchestrator never calls these directly; it
 * delegates plain-language outfit requests via the `Fashion` tool, which
 * spawns the Fashion subagent that owns this surface.
 */

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import {
  handleFashionCreateCheckout,
  handleFashionCreateOutfit,
  handleFashionGetContext,
  handleFashionGetProductDetails,
  handleFashionMarkOutfitFailed,
  handleFashionMarkOutfitReady,
  handleFashionSearchProducts,
} from "../fashion.js";
import type {
  FashionToolApi,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types.js";

export type FashionControlOptions = {
  fashionApi?: FashionToolApi;
};

const requireFashionAgent = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.FASHION
    ? null
    : { error: `${toolName} is only available to the Fashion agent.` };

export const createFashionControlTools = (
  options: FashionControlOptions,
): ToolDefinition[] => [
  {
    name: "FashionGetContext",
    description:
      "Load the user's Fashion context: profile (sizes, style preferences) and recent likes / cart / outfit-product history. Call once at the start of every batch to bias selections.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_args, context) => {
      const denied = requireFashionAgent("FashionGetContext", context);
      if (denied) return denied;
      try {
        return await handleFashionGetContext(options.fashionApi);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "FashionSearchProducts",
    description:
      "Search the global Shopify (UCP) catalog for products matching a slot-specific query. Returns a small list of {productId, variantId, title, vendor, price, currency, imageUrl, productUrl, merchantOrigin}. Run multiple searches in parallel via multi_tool_use_parallel when filling slots.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Slot-specific search query (e.g. 'cropped cream cable knit sweater', 'dark high-waisted denim').",
        },
        context: {
          type: "string",
          description:
            "Optional broader context Shopify can use to bias relevance (e.g. 'cozy fall walk outfit, neutral palette').",
        },
        limit: {
          type: "number",
          description:
            "Max products to return (defaults to 10, max 20).",
        },
        savedCatalog: {
          type: "string",
          description:
            "Optional Shopify saved-catalog id to scope the search.",
        },
      },
      required: ["query"],
    },
    execute: async (args, context) => {
      const denied = requireFashionAgent("FashionSearchProducts", context);
      if (denied) return denied;
      try {
        return await handleFashionSearchProducts(options.fashionApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "FashionGetProductDetails",
    description:
      "Fetch full UCP product detail (variants, options, full description) for a productId returned by FashionSearchProducts. Use sparingly — only when you need variant-level info to pick a size or color.",
    parameters: {
      type: "object",
      properties: {
        productId: {
          type: "string",
          description: "Shopify global product id.",
        },
      },
      required: ["productId"],
    },
    execute: async (args, context) => {
      const denied = requireFashionAgent("FashionGetProductDetails", context);
      if (denied) return denied;
      try {
        return await handleFashionGetProductDetails(options.fashionApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "FashionCreateOutfit",
    description:
      "Reserve a Fashion-feed card for an assembled outfit. Returns an outfitId. Call this BEFORE rendering with image_gen so the UI shows a placeholder card while the try-on image is being generated.",
    parameters: {
      type: "object",
      properties: {
        batchId: {
          type: "string",
          description:
            "Batch identifier from the orchestrator/UI prompt — every outfit in this batch must share it.",
        },
        ordinal: {
          type: "number",
          description:
            "0-indexed position of this outfit within the batch (0, 1, 2, …).",
        },
        themeLabel: {
          type: "string",
          description:
            "Short user-facing label (1-4 words): 'cozy fall walk', 'office layered'.",
        },
        themeDescription: {
          type: "string",
          description:
            "Optional 1-sentence elaboration for the card (e.g. 'soft neutrals for a chilly afternoon').",
        },
        stylePrompt: {
          type: "string",
          description:
            "Optional internal style note for the batch (you can echo the seedHint that drove this look).",
        },
        products: {
          type: "array",
          description:
            "One entry per slot in the outfit. Each must include slot, productId, variantId, title, merchantOrigin (and ideally price, currency, imageUrl, productUrl).",
          items: {
            type: "object",
            properties: {
              slot: { type: "string", description: "top, bottom, shoes, outerwear, accessory, dress, …" },
              productId: { type: "string" },
              variantId: { type: "string" },
              title: { type: "string" },
              vendor: { type: "string" },
              price: { type: "number" },
              currency: { type: "string" },
              imageUrl: { type: "string" },
              productUrl: { type: "string" },
              checkoutUrl: { type: "string" },
              merchantOrigin: {
                type: "string",
                description:
                  "Origin of the merchant's UCP endpoint (used later by the cart/checkout flow).",
              },
            },
            required: ["slot", "productId", "variantId", "title", "merchantOrigin"],
          },
        },
        tryOnPrompt: {
          type: "string",
          description:
            "The exact prompt you'll feed to image_gen (so the UI can replay later).",
        },
      },
      required: ["batchId", "ordinal", "themeLabel", "products"],
    },
    execute: async (args, context) => {
      const denied = requireFashionAgent("FashionCreateOutfit", context);
      if (denied) return denied;
      try {
        return await handleFashionCreateOutfit(options.fashionApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "FashionMarkOutfitReady",
    description:
      "Attach a rendered try-on image to an outfit card. Call after image_gen succeeds. Provide tryOnImagePath (absolute local path returned by image_gen) and/or tryOnImageUrl.",
    parameters: {
      type: "object",
      properties: {
        outfitId: {
          type: "string",
          description: "outfitId returned by FashionCreateOutfit.",
        },
        tryOnImagePath: {
          type: "string",
          description: "Absolute local file path of the rendered try-on image.",
        },
        tryOnImageUrl: {
          type: "string",
          description: "Optional remote URL of the rendered image.",
        },
      },
      required: ["outfitId"],
    },
    execute: async (args, context) => {
      const denied = requireFashionAgent("FashionMarkOutfitReady", context);
      if (denied) return denied;
      try {
        return await handleFashionMarkOutfitReady(options.fashionApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "FashionMarkOutfitFailed",
    description:
      "Mark an outfit card as failed (image_gen errored, no usable products, etc.). The UI will hide it from the feed.",
    parameters: {
      type: "object",
      properties: {
        outfitId: {
          type: "string",
          description: "outfitId returned by FashionCreateOutfit.",
        },
        errorMessage: {
          type: "string",
          description: "One-line reason for the failure.",
        },
      },
      required: ["outfitId", "errorMessage"],
    },
    execute: async (args, context) => {
      const denied = requireFashionAgent("FashionMarkOutfitFailed", context);
      if (denied) return denied;
      try {
        return await handleFashionMarkOutfitFailed(options.fashionApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "FashionCreateCheckout",
    description:
      "Open a UCP checkout session for a list of selected variants from a single merchant. Falls back to a Shopify cart permalink when the merchant doesn't expose Checkout MCP. Reserved for direct-purchase flows; the Fashion UI usually calls this from the renderer rather than the agent.",
    parameters: {
      type: "object",
      properties: {
        merchantOrigin: {
          type: "string",
          description: "Merchant origin returned by FashionSearchProducts.",
        },
        lines: {
          type: "array",
          description: "Variants to add to the checkout.",
          items: {
            type: "object",
            properties: {
              variantId: { type: "string" },
              quantity: { type: "number" },
            },
            required: ["variantId"],
          },
        },
      },
      required: ["merchantOrigin", "lines"],
    },
    execute: async (args, context) => {
      const denied = requireFashionAgent("FashionCreateCheckout", context);
      if (denied) return denied;
      try {
        return await handleFashionCreateCheckout(options.fashionApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
];
