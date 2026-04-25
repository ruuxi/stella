/**
 * Fashion tool handlers.
 *
 * Pairs with the Fashion subagent (`runtime/extensions/stella-runtime/agents/fashion.md`)
 * and its control tools. Handlers wrap the `FashionToolApi` (which forwards to
 * Convex actions) and shape responses the model can reason about — searches collapse to a small list of
 * `{slot-friendly title, ids, price, imageUrl, merchantOrigin}` rows
 * instead of the raw upstream Shopify payload.
 */

import type {
  FashionOutfitProductInput,
  FashionToolApi,
  ToolResult,
} from "./types.js";

const requireFashionApi = (fashionApi?: FashionToolApi): FashionToolApi => {
  if (!fashionApi) {
    throw new Error(
      "Fashion features are not configured on this device. Sign in and connect Stella to Convex.",
    );
  }
  return fashionApi;
};

const getString = (
  args: Record<string, unknown>,
  field: string,
): string => {
  const raw = args[field];
  return typeof raw === "string" ? raw.trim() : "";
};

const requireString = (
  args: Record<string, unknown>,
  field: string,
): string => {
  const value = getString(args, field);
  if (!value) throw new Error(`${field} is required.`);
  return value;
};

const getOptionalString = (
  args: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = getString(args, field);
  return value ? value : undefined;
};

const getNumber = (
  args: Record<string, unknown>,
  field: string,
): number | undefined => {
  const raw = args[field];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return undefined;
};

const formatProducts = (
  products: Array<{
    productId: string;
    variantId: string;
    title: string;
    vendor?: string;
    price?: number;
    currency?: string;
    imageUrl?: string;
    productUrl?: string;
    merchantOrigin: string;
  }>,
): string => {
  if (products.length === 0) {
    return "No products matched. Try broadening the query or pivoting on color/fabric.";
  }
  return products
    .map((p, i) => {
      const priceLabel =
        typeof p.price === "number"
          ? `${p.currency ?? ""} ${p.price.toFixed(2)}`.trim()
          : "(price?)";
      const vendor = p.vendor ? ` — ${p.vendor}` : "";
      const image = p.imageUrl ? `\n   imageUrl: ${p.imageUrl}` : "";
      const productUrl = p.productUrl ? `\n   productUrl: ${p.productUrl}` : "";
      return `${i + 1}. ${p.title}${vendor}\n   productId: ${p.productId}\n   variantId: ${p.variantId}\n   merchantOrigin: ${p.merchantOrigin}\n   price: ${priceLabel}${image}${productUrl}`;
    })
    .join("\n");
};

export const handleFashionGetContext = async (
  fashionApi: FashionToolApi | undefined,
): Promise<ToolResult> => {
  const api = requireFashionApi(fashionApi);
  const ctx = await api.getOrchestratorContext();
  return { result: JSON.stringify(ctx, null, 2), details: ctx };
};

export const handleFashionSearchProducts = async (
  fashionApi: FashionToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireFashionApi(fashionApi);
  const query = requireString(args, "query");
  const context = getOptionalString(args, "context");
  const limit = getNumber(args, "limit");
  const savedCatalog = getOptionalString(args, "savedCatalog");
  const products = await api.searchProducts({
    query,
    ...(context ? { context } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(savedCatalog ? { savedCatalog } : {}),
  });
  return { result: formatProducts(products), details: products };
};

export const handleFashionGetProductDetails = async (
  fashionApi: FashionToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireFashionApi(fashionApi);
  const productId = requireString(args, "productId");
  const detail = await api.getProductDetails({ productId });
  if (!detail) {
    return { error: `No product details available for ${productId}.` };
  }
  return { result: JSON.stringify(detail, null, 2), details: detail };
};

const normalizeOutfitProducts = (
  raw: unknown,
): FashionOutfitProductInput[] => {
  if (!Array.isArray(raw)) {
    throw new Error("products must be an array.");
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`products[${index}] must be an object.`);
    }
    const r = entry as Record<string, unknown>;
    const slot = typeof r.slot === "string" ? r.slot.trim() : "";
    const productId = typeof r.productId === "string" ? r.productId.trim() : "";
    const variantId = typeof r.variantId === "string" ? r.variantId.trim() : "";
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const merchantOrigin =
      typeof r.merchantOrigin === "string" ? r.merchantOrigin.trim() : "";
    if (!slot || !productId || !variantId || !title || !merchantOrigin) {
      throw new Error(
        `products[${index}] requires slot, productId, variantId, title, merchantOrigin.`,
      );
    }
    return {
      slot,
      productId,
      variantId,
      title,
      merchantOrigin,
      ...(typeof r.price === "number" && Number.isFinite(r.price)
        ? { price: r.price }
        : {}),
      ...(typeof r.currency === "string" && r.currency.trim().length > 0
        ? { currency: r.currency.trim() }
        : {}),
      ...(typeof r.imageUrl === "string" && r.imageUrl.trim().length > 0
        ? { imageUrl: r.imageUrl.trim() }
        : {}),
      ...(typeof r.productUrl === "string" && r.productUrl.trim().length > 0
        ? { productUrl: r.productUrl.trim() }
        : {}),
      ...(typeof r.checkoutUrl === "string" && r.checkoutUrl.trim().length > 0
        ? { checkoutUrl: r.checkoutUrl.trim() }
        : {}),
      ...(typeof r.vendor === "string" && r.vendor.trim().length > 0
        ? { vendor: r.vendor.trim() }
        : {}),
    };
  });
};

export const handleFashionCreateOutfit = async (
  fashionApi: FashionToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireFashionApi(fashionApi);
  const batchId = requireString(args, "batchId");
  const ordinalRaw = getNumber(args, "ordinal");
  if (typeof ordinalRaw !== "number" || ordinalRaw < 0) {
    return { error: "ordinal must be a non-negative number." };
  }
  const themeLabel = requireString(args, "themeLabel");
  const themeDescription = getOptionalString(args, "themeDescription");
  const stylePrompt = getOptionalString(args, "stylePrompt");
  const tryOnPrompt = getOptionalString(args, "tryOnPrompt");
  let products: FashionOutfitProductInput[];
  try {
    products = normalizeOutfitProducts(args.products);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (products.length === 0) {
    return { error: "products must include at least one slot." };
  }
  const outfitId = await api.registerOutfit({
    batchId,
    ordinal: Math.floor(ordinalRaw),
    themeLabel,
    ...(themeDescription ? { themeDescription } : {}),
    ...(stylePrompt ? { stylePrompt } : {}),
    products,
    ...(tryOnPrompt ? { tryOnPrompt } : {}),
  });
  return {
    result: `Outfit registered (placeholder card created). outfitId: ${outfitId}`,
    details: { outfitId, batchId, ordinal: Math.floor(ordinalRaw) },
  };
};

export const handleFashionMarkOutfitReady = async (
  fashionApi: FashionToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireFashionApi(fashionApi);
  const outfitId = requireString(args, "outfitId");
  const tryOnImagePath = getOptionalString(args, "tryOnImagePath");
  const tryOnImageUrl = getOptionalString(args, "tryOnImageUrl");
  if (!tryOnImagePath && !tryOnImageUrl) {
    return {
      error: "Provide tryOnImagePath (local file) or tryOnImageUrl.",
    };
  }
  await api.markOutfitReady({
    outfitId,
    ...(tryOnImagePath ? { tryOnImagePath } : {}),
    ...(tryOnImageUrl ? { tryOnImageUrl } : {}),
  });
  return { result: `Outfit ${outfitId} marked ready.` };
};

export const handleFashionMarkOutfitFailed = async (
  fashionApi: FashionToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireFashionApi(fashionApi);
  const outfitId = requireString(args, "outfitId");
  const errorMessage = requireString(args, "errorMessage");
  await api.markOutfitFailed({ outfitId, errorMessage });
  return { result: `Outfit ${outfitId} marked failed: ${errorMessage}` };
};

export const handleFashionCreateCheckout = async (
  fashionApi: FashionToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireFashionApi(fashionApi);
  const merchantOrigin = requireString(args, "merchantOrigin");
  const linesRaw = Array.isArray(args.lines) ? args.lines : [];
  const lines = linesRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const r = entry as Record<string, unknown>;
      const variantId = typeof r.variantId === "string" ? r.variantId.trim() : "";
      const quantity =
        typeof r.quantity === "number" && Number.isFinite(r.quantity)
          ? Math.max(1, Math.floor(r.quantity))
          : 1;
      if (!variantId) return null;
      return { variantId, quantity };
    })
    .filter((entry): entry is { variantId: string; quantity: number } => Boolean(entry));
  if (lines.length === 0) {
    return { error: "lines must include at least one { variantId, quantity }." };
  }
  const session = await api.createCheckout({ merchantOrigin, lines });
  return {
    result:
      session.usingMcp
        ? `Checkout created via Checkout MCP. Open ${session.continueUrl ?? session.cartUrl ?? "(no continue URL)"} to complete payment.`
        : `Merchant doesn't expose Checkout MCP. Opened cart permalink: ${session.continueUrl ?? session.cartUrl ?? "(no URL)"}`,
    details: session,
  };
};
