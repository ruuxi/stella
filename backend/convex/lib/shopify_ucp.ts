/**
 * Shopify Universal Commerce Protocol (UCP) client library.
 *
 * Used by the Fashion tab + agent flow to:
 *   - Search the global Shopify catalog (`search_global_products`)
 *   - Fetch product details (`get_global_product_details`)
 *   - Resolve per-merchant Checkout MCP endpoints via `/.well-known/ucp`
 *   - Open / update / cancel a hosted checkout session via Checkout MCP
 *     (`create_checkout`, `update_checkout`, `cancel_checkout`)
 *
 * All HTTP lives here — Convex actions in `agent/local_runtime.ts` call the
 * helpers exported below. Token-exchange is cached for the duration of one
 * Convex action invocation; no persistent token store, no global state.
 *
 * Required env vars (set on the backend Convex deployment):
 *   - SHOPIFY_UCP_CLIENT_ID
 *   - SHOPIFY_UCP_CLIENT_SECRET
 * Optional env vars:
 *   - SHOPIFY_UCP_TOKEN_URL                (defaults to the Shopify auth URL)
 *   - SHOPIFY_UCP_GLOBAL_SEARCH_ENDPOINT   (defaults to discover.shopifyapps.com)
 *   - SHOPIFY_UCP_DEFAULT_SAVED_CATALOG    (optional named saved-catalog id)
 *
 * The shape of every response is intentionally narrowed to the fields the
 * fashion runtime needs — passing the entire upstream payload through to the
 * model bloats prompts and exposes us to provider drift.
 */

import type { Value } from "convex/values";

const SHOPIFY_TOKEN_URL = "https://api.shopify.com/auth/access_token";
const SHOPIFY_GLOBAL_MCP_URL = "https://discover.shopifyapps.com/global/mcp";
const TOKEN_TTL_MS = 50 * 60_000; // refresh well before the upstream expiry

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const trim = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const sanitizeUrl = (value: string | undefined): string | undefined => {
  const trimmed = trim(value);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!isNonEmptyString(value)) {
    throw new Error(
      `Shopify UCP is not configured: missing env var ${name} on the Convex backend.`,
    );
  }
  return value.trim();
};

/**
 * Lightweight env probe used by the renderer to decide whether to surface the
 * Fashion tab as configured. Doesn't perform any HTTP — the UI uses this to
 * render a friendly "not configured" notice instead of having actions throw.
 */
export const isShopifyUcpConfigured = (): boolean =>
  isNonEmptyString(process.env.SHOPIFY_UCP_CLIENT_ID) &&
  isNonEmptyString(process.env.SHOPIFY_UCP_CLIENT_SECRET);

// ---------------------------------------------------------------------------
// Token cache (per Convex action invocation; resets between cold starts).
// ---------------------------------------------------------------------------

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

let cachedShopifyToken: CachedToken | null = null;

const fetchAccessToken = async (): Promise<string> => {
  if (
    cachedShopifyToken &&
    cachedShopifyToken.expiresAtMs > Date.now() + 5_000
  ) {
    return cachedShopifyToken.token;
  }
  const clientId = requireEnv("SHOPIFY_UCP_CLIENT_ID");
  const clientSecret = requireEnv("SHOPIFY_UCP_CLIENT_SECRET");
  const tokenUrl = sanitizeUrl(process.env.SHOPIFY_UCP_TOKEN_URL) ?? SHOPIFY_TOKEN_URL;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Shopify UCP token exchange failed (${response.status}): ${detail.slice(0, 500)}`,
    );
  }
  const body = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  const token = trim(body.access_token);
  if (!token) {
    throw new Error("Shopify UCP token exchange returned no access_token.");
  }
  const ttlSeconds =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? Math.max(60, Math.floor(body.expires_in))
      : Math.floor(TOKEN_TTL_MS / 1000);
  cachedShopifyToken = {
    token,
    expiresAtMs: Date.now() + ttlSeconds * 1000,
  };
  return token;
};

// ---------------------------------------------------------------------------
// JSON-RPC over MCP HTTP transport.
// ---------------------------------------------------------------------------

type McpToolCallResult = {
  /** Raw tool result envelope returned by the MCP server. */
  raw: unknown;
  /** First text content block (Shopify returns JSON-encoded text content). */
  text: string | null;
  /** Parsed JSON when `text` is JSON; otherwise null. */
  json: unknown;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(10_000, Math.floor(seconds * 1000));
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(10_000, Math.max(0, dateMs - Date.now()));
  }
  return undefined;
};

const callMcpTool = async (args: {
  endpoint: string;
  toolName: string;
  arguments: Record<string, unknown>;
  authToken: string;
}): Promise<McpToolCallResult> => {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(args.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.authToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        id: Math.floor(Math.random() * 1_000_000),
        params: {
          name: args.toolName,
          arguments: args.arguments,
        },
      }),
    });
    if (response.status !== 429 || attempt === 2) break;
    await sleep(
      parseRetryAfterMs(response.headers.get("retry-after")) ??
        750 * 2 ** attempt,
    );
  }
  if (!response) {
    throw new Error(`Shopify UCP ${args.toolName} did not return a response.`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Shopify UCP ${args.toolName} failed (${response.status}): ${detail.slice(0, 800)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; code?: unknown } | null;
    result?: { content?: unknown; isError?: unknown } | null;
  } | null;
  if (!body) {
    throw new Error(`Shopify UCP ${args.toolName} returned an invalid JSON response.`);
  }
  if (body.error) {
    const message = trim(body.error.message) || `Shopify UCP error`;
    throw new Error(`Shopify UCP ${args.toolName} error: ${message}`);
  }
  const result = body.result ?? null;
  if (!result || typeof result !== "object") {
    throw new Error(`Shopify UCP ${args.toolName} returned no result envelope.`);
  }
  const isError = (result as { isError?: unknown }).isError === true;
  const content = (result as { content?: unknown }).content;
  let text: string | null = null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        isNonEmptyString((block as { text?: unknown }).text)
      ) {
        text = (block as { text: string }).text;
        break;
      }
    }
  }
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (isError) {
    const jsonMessage =
      json && typeof json === "object"
        ? trim((json as { message?: unknown }).message)
        : "";
    const errorMessage =
      jsonMessage ||
      text ||
      `Shopify UCP ${args.toolName} reported an error`;
    throw new Error(errorMessage);
  }
  return { raw: result, text, json };
};

// ---------------------------------------------------------------------------
// search_global_products
// ---------------------------------------------------------------------------

export type ShopifySearchProduct = {
  productId: string;
  variantId: string;
  title: string;
  vendor?: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  checkoutUrl?: string;
  merchantOrigin: string;
};

const findProductId = (entry: Record<string, unknown>): string => {
  const candidates: unknown[] = [
    entry.product_id,
    entry.productId,
    entry.id,
    entry.gid,
  ];
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return "";
};

const findVariantId = (entry: Record<string, unknown>): string => {
  const candidates: unknown[] = [
    entry.variant_id,
    entry.variantId,
    entry.default_variant_id,
    entry.first_variant_id,
  ];
  const variants = entry.variants;
  if (Array.isArray(variants) && variants.length > 0) {
    const first = variants[0];
    if (first && typeof first === "object") {
      candidates.push((first as { id?: unknown }).id);
      candidates.push((first as { variant_id?: unknown }).variant_id);
    }
  }
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return "";
};

const findPrice = (
  entry: Record<string, unknown>,
): { price?: number; currency?: string } => {
  const normalizePriceAmount = (
    amount: unknown,
    currency: unknown,
    source: Record<string, unknown>,
  ): number | undefined => {
    const numericAmount =
      typeof amount === "string" && amount.trim()
        ? Number(amount)
        : typeof amount === "number"
          ? amount
          : undefined;
    if (typeof numericAmount !== "number" || !Number.isFinite(numericAmount)) {
      return undefined;
    }

    const sourceKeys = Object.keys(source).map((key) => key.toLowerCase());
    const explicitMinorUnit = sourceKeys.some((key) =>
      key.includes("cent") ||
      key.includes("minor") ||
      key === "unit_amount" ||
      key === "amount_in_cents",
    );
    if (explicitMinorUnit) return numericAmount / 100;

    // Shopify UCP search results have been observed returning whole-number
    // minor-unit amounts in objects like `{ amount: 12900, currency: "USD" }`.
    // Decimal strings such as "129.00" are already major units and pass through.
    const hasDecimalString =
      typeof amount === "string" && /[.,]\d{1,2}\s*$/.test(amount.trim());
    const hasCurrency = isNonEmptyString(currency);
    if (
      hasCurrency &&
      !hasDecimalString &&
      Number.isInteger(numericAmount) &&
      numericAmount >= 1000
    ) {
      return numericAmount / 100;
    }

    return numericAmount;
  };

  const sources: unknown[] = [
    entry.price,
    entry.price_range,
    entry.priceRange,
    entry.default_price,
    entry.starting_price,
  ];
  for (const source of sources) {
    if (typeof source === "number" && Number.isFinite(source)) {
      const currency =
        entry.currency ??
        entry.currency_code ??
        entry.currencyCode;
      const price =
        Number.isInteger(source) && source >= 1000 ? source / 100 : source;
      return {
        price,
        ...(isNonEmptyString(currency) ? { currency: currency.trim() } : {}),
      };
    }
    if (source && typeof source === "object") {
      const record = source as Record<string, unknown>;
      const minRecord =
        record.min && typeof record.min === "object"
          ? (record.min as { amount?: unknown; currency?: unknown })
          : undefined;
      const amount =
        record.amount ??
        record.value ??
        minRecord?.amount ??
        (record.minimum && typeof record.minimum === "object"
          ? (record.minimum as { amount?: unknown }).amount
          : undefined);
      const currency =
        record.currency ??
        record.currency_code ??
        record.currencyCode ??
        minRecord?.currency ??
        (record.minimum && typeof record.minimum === "object"
          ? (record.minimum as { currency_code?: unknown }).currency_code
          : undefined);
      const numericAmount =
        normalizePriceAmount(amount, currency, record);
      if (typeof numericAmount === "number") {
        return {
          price: numericAmount,
          ...(isNonEmptyString(currency) ? { currency: currency.trim() } : {}),
        };
      }
    }
  }
  return {};
};

const findImageUrl = (entry: Record<string, unknown>): string | undefined => {
  const candidates: unknown[] = [
    entry.image_url,
    entry.imageUrl,
    entry.image,
    entry.featured_image,
    entry.featuredImage,
  ];
  const images = entry.images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0];
    if (typeof first === "string") candidates.push(first);
    if (first && typeof first === "object") {
      candidates.push((first as { url?: unknown }).url);
      candidates.push((first as { src?: unknown }).src);
    }
  }
  const media = entry.media;
  if (Array.isArray(media) && media.length > 0) {
    const first = media[0];
    if (typeof first === "string") candidates.push(first);
    if (first && typeof first === "object") {
      candidates.push((first as { url?: unknown }).url);
      candidates.push((first as { src?: unknown }).src);
    }
  }
  const variants = entry.variants;
  if (Array.isArray(variants) && variants.length > 0) {
    const firstVariant = variants[0];
    if (firstVariant && typeof firstVariant === "object") {
      const variantMedia = (firstVariant as Record<string, unknown>).media;
      if (Array.isArray(variantMedia) && variantMedia.length > 0) {
        const first = variantMedia[0];
        if (typeof first === "string") candidates.push(first);
        if (first && typeof first === "object") {
          candidates.push((first as { url?: unknown }).url);
          candidates.push((first as { src?: unknown }).src);
        }
      }
    }
  }
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (isNonEmptyString(record.url)) return record.url.trim();
      if (isNonEmptyString(record.src)) return record.src.trim();
    }
  }
  return undefined;
};

const findProductUrl = (
  entry: Record<string, unknown>,
): { productUrl?: string; merchantOrigin: string } => {
  const url =
    sanitizeUrl(typeof entry.product_url === "string" ? entry.product_url : undefined) ??
    sanitizeUrl(typeof entry.productUrl === "string" ? entry.productUrl : undefined) ??
    sanitizeUrl(typeof entry.variantUrl === "string" ? entry.variantUrl : undefined) ??
    sanitizeUrl(typeof entry.lookupUrl === "string" ? entry.lookupUrl : undefined) ??
    sanitizeUrl(typeof entry.url === "string" ? entry.url : undefined) ??
    sanitizeUrl(typeof entry.canonical_url === "string" ? entry.canonical_url : undefined);
  let merchantOrigin = "";
  if (url) {
    try {
      merchantOrigin = new URL(url).origin;
    } catch {
      // ignore — handled below
    }
  }
  if (!merchantOrigin) {
    const explicit =
      sanitizeUrl(typeof entry.merchant_origin === "string" ? entry.merchant_origin : undefined) ??
      sanitizeUrl(typeof entry.shop_url === "string" ? entry.shop_url : undefined) ??
      sanitizeUrl(typeof entry.store_url === "string" ? entry.store_url : undefined) ??
      (entry.shop && typeof entry.shop === "object"
        ? sanitizeUrl(
            typeof (entry.shop as { onlineStoreUrl?: unknown }).onlineStoreUrl === "string"
              ? (entry.shop as { onlineStoreUrl: string }).onlineStoreUrl
              : undefined,
          )
        : undefined);
    if (explicit) {
      try {
        merchantOrigin = new URL(explicit).origin;
      } catch {
        merchantOrigin = "";
      }
    }
  }
  return { ...(url ? { productUrl: url } : {}), merchantOrigin };
};

const normalizeSearchProduct = (
  entry: Record<string, unknown>,
): ShopifySearchProduct | null => {
  const variants = Array.isArray(entry.variants) ? entry.variants : [];
  const firstVariant =
    variants.length > 0 && variants[0] && typeof variants[0] === "object"
      ? (variants[0] as Record<string, unknown>)
      : null;
  const normalizedEntry = {
    ...entry,
    ...(firstVariant ? {
      variantId: firstVariant.id,
      productId: firstVariant.productId ?? entry.id,
      variantUrl: firstVariant.variantUrl,
      checkoutUrl: firstVariant.checkoutUrl,
      price: firstVariant.price ?? entry.priceRange,
      shop: firstVariant.shop ?? entry.shop,
      media: firstVariant.media ?? entry.media,
    } : {}),
  };
  const productId = findProductId(normalizedEntry);
  if (!productId) return null;
  const variantId = findVariantId(normalizedEntry) || productId;
  const title = trim(entry.title) || trim(entry.name) || trim(firstVariant?.displayName);
  if (!title) return null;
  const { price, currency } = findPrice(normalizedEntry);
  const imageUrl = findImageUrl(normalizedEntry);
  const { productUrl, merchantOrigin } = findProductUrl(normalizedEntry);
  if (!merchantOrigin) return null;
  const vendor =
    trim(entry.vendor) ||
    trim(entry.brand) ||
    trim(entry.shop_name) ||
    (normalizedEntry.shop && typeof normalizedEntry.shop === "object"
      ? trim((normalizedEntry.shop as { name?: unknown }).name)
      : "");
  const description = trim(entry.description) || trim(entry.summary);
  return {
    productId,
    variantId,
    title,
    ...(vendor ? { vendor } : {}),
    ...(description ? { description: description.slice(0, 600) } : {}),
    ...(typeof price === "number" ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(productUrl ? { productUrl } : {}),
    ...(typeof normalizedEntry.checkoutUrl === "string"
      ? { checkoutUrl: normalizedEntry.checkoutUrl }
      : {}),
    merchantOrigin,
  };
};

const extractProductsFromJson = (json: unknown): Record<string, unknown>[] => {
  if (!json) return [];
  if (Array.isArray(json)) {
    return json.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object"),
    );
  }
  if (typeof json === "object") {
    const record = json as Record<string, unknown>;
    const candidates = [
      record.products,
      record.offers,
      record.results,
      record.items,
      record.data,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        );
      }
    }
  }
  return [];
};

export const searchGlobalProducts = async (args: {
  query: string;
  context?: string;
  limit?: number;
  savedCatalog?: string;
}): Promise<ShopifySearchProduct[]> => {
  const query = trim(args.query);
  if (!query) {
    throw new Error("Shopify search query is required.");
  }
  const limit = Math.max(1, Math.min(40, Math.floor(args.limit ?? 10)));
  const savedCatalog =
    trim(args.savedCatalog) ||
    trim(process.env.SHOPIFY_UCP_DEFAULT_SAVED_CATALOG);
  const endpoint =
    sanitizeUrl(process.env.SHOPIFY_UCP_GLOBAL_SEARCH_ENDPOINT) ??
    SHOPIFY_GLOBAL_MCP_URL;

  const token = await fetchAccessToken();
  const result = await callMcpTool({
    endpoint,
    toolName: "search_global_products",
    authToken: token,
    arguments: {
      query,
      context: trim(args.context),
      limit,
      ...(savedCatalog ? { saved_catalog: savedCatalog } : {}),
    },
  });

  const entries = extractProductsFromJson(result.json ?? result.raw);
  const products: ShopifySearchProduct[] = [];
  for (const entry of entries) {
    const normalized = normalizeSearchProduct(entry);
    if (normalized) products.push(normalized);
    if (products.length >= limit) break;
  }
  return products;
};

export const debugSearchGlobalProducts = async (args: {
  query: string;
  context?: string;
  limit?: number;
  savedCatalog?: string;
}): Promise<Value> => {
  const query = trim(args.query);
  if (!query) {
    throw new Error("Shopify search query is required.");
  }
  const limit = Math.max(1, Math.min(40, Math.floor(args.limit ?? 10)));
  const savedCatalog =
    trim(args.savedCatalog) ||
    trim(process.env.SHOPIFY_UCP_DEFAULT_SAVED_CATALOG);
  const endpoint =
    sanitizeUrl(process.env.SHOPIFY_UCP_GLOBAL_SEARCH_ENDPOINT) ??
    SHOPIFY_GLOBAL_MCP_URL;

  const token = await fetchAccessToken();
  const callArgs = {
    query,
    context: trim(args.context),
    limit,
    ...(savedCatalog ? { saved_catalog: savedCatalog } : {}),
  };
  const result = await callMcpTool({
    endpoint,
    toolName: "search_global_products",
    authToken: token,
    arguments: callArgs,
  });
  const entries = extractProductsFromJson(result.json ?? result.raw);
  const normalized = entries
    .map((entry) => normalizeSearchProduct(entry))
    .filter((entry): entry is ShopifySearchProduct => Boolean(entry));

  return {
    endpoint,
    arguments: callArgs,
    text: result.text,
    json: result.json,
    raw: result.raw,
    extractedCount: entries.length,
    normalizedCount: normalized.length,
    normalized,
  } as Value;
};

// ---------------------------------------------------------------------------
// get_global_product_details
// ---------------------------------------------------------------------------

export type ShopifyProductDetail = ShopifySearchProduct & {
  variants?: Array<{
    variantId: string;
    title?: string;
    price?: number;
    currency?: string;
    available?: boolean;
    options?: Record<string, string>;
  }>;
};

const normalizeVariants = (
  raw: unknown,
): ShopifyProductDetail["variants"] => {
  if (!Array.isArray(raw)) return undefined;
  const normalized: NonNullable<ShopifyProductDetail["variants"]> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const variantId =
      trim(record.id) ||
      trim(record.variant_id) ||
      trim(record.variantId);
    if (!variantId) continue;
    const { price, currency } = findPrice(record);
    const optionsRaw = record.options;
    const options: Record<string, string> = {};
    if (optionsRaw && typeof optionsRaw === "object" && !Array.isArray(optionsRaw)) {
      for (const [key, value] of Object.entries(optionsRaw as Record<string, unknown>)) {
        if (isNonEmptyString(value)) options[key] = value.trim();
      }
    }
    normalized.push({
      variantId,
      ...(isNonEmptyString(record.title) ? { title: record.title.trim() } : {}),
      ...(typeof price === "number" ? { price } : {}),
      ...(currency ? { currency } : {}),
      ...(typeof record.available === "boolean" ? { available: record.available } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
};

export const getGlobalProductDetails = async (args: {
  productId: string;
}): Promise<ShopifyProductDetail | null> => {
  const productId = trim(args.productId);
  if (!productId) {
    throw new Error("productId is required for product details lookup.");
  }
  const endpoint =
    sanitizeUrl(process.env.SHOPIFY_UCP_GLOBAL_SEARCH_ENDPOINT) ??
    SHOPIFY_GLOBAL_MCP_URL;
  const token = await fetchAccessToken();
  const result = await callMcpTool({
    endpoint,
    toolName: "get_global_product_details",
    authToken: token,
    arguments: { product_id: productId },
  });
  const json = result.json ?? result.raw;
  if (!json || typeof json !== "object") return null;
  const record = (json as Record<string, unknown>).product
    ? ((json as Record<string, unknown>).product as Record<string, unknown>)
    : (json as Record<string, unknown>);
  const base = normalizeSearchProduct(record);
  if (!base) return null;
  const variants = normalizeVariants(record.variants);
  return { ...base, ...(variants ? { variants } : {}) };
};

// ---------------------------------------------------------------------------
// Checkout MCP (per-merchant) — discovery + create / update / cancel.
// ---------------------------------------------------------------------------

export type CheckoutEndpointDescriptor = {
  /** Origin we discovered from. */
  merchantOrigin: string;
  /** MCP endpoint URL. */
  endpoint: string;
};

type UcpDiscoveryResponse = {
  endpoints?: Array<{
    name?: unknown;
    url?: unknown;
    transport?: unknown;
  }> | null;
};

const isCheckoutEndpoint = (descriptor: { name?: unknown }): boolean => {
  if (!isNonEmptyString(descriptor.name)) return false;
  const name = descriptor.name.trim().toLowerCase();
  return name === "checkout" || name === "checkout_mcp" || name === "checkout-mcp";
};

export const discoverCheckoutEndpoint = async (args: {
  merchantOrigin: string;
}): Promise<CheckoutEndpointDescriptor | null> => {
  const origin = sanitizeUrl(args.merchantOrigin);
  if (!origin) return null;
  let baseOrigin = "";
  try {
    baseOrigin = new URL(origin).origin;
  } catch {
    return null;
  }
  const wellKnown = `${baseOrigin}/.well-known/ucp`;
  let response: Response;
  try {
    response = await fetch(wellKnown, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: UcpDiscoveryResponse;
  try {
    body = (await response.json()) as UcpDiscoveryResponse;
  } catch {
    return null;
  }
  if (!body || !Array.isArray(body.endpoints)) return null;
  for (const descriptor of body.endpoints) {
    if (!descriptor || typeof descriptor !== "object") continue;
    if (!isCheckoutEndpoint(descriptor)) continue;
    const url = sanitizeUrl(typeof descriptor.url === "string" ? descriptor.url : undefined);
    if (!url) continue;
    return { merchantOrigin: baseOrigin, endpoint: url };
  }
  return null;
};

export type CheckoutLineInput = {
  variantId: string;
  quantity: number;
};

const variantIdForCartPermalink = (variantId: string): string => {
  const trimmed = variantId.trim();
  const gidMatch = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/i.exec(trimmed);
  if (gidMatch?.[1]) return gidMatch[1];
  return trimmed;
};

export type CheckoutSessionResult = {
  /** Upstream checkout/session id. */
  checkoutId: string;
  /** Status string from upstream (`open`, `pending`, `completed`, …). */
  status: string;
  /** URL the user should open to complete payment. */
  continueUrl?: string;
  /** Whole upstream response body (so callers can persist it). */
  raw: unknown;
};

const extractCheckoutSession = (
  raw: unknown,
): CheckoutSessionResult | null => {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const checkout =
    record.checkout && typeof record.checkout === "object"
      ? (record.checkout as Record<string, unknown>)
      : record;
  const checkoutId =
    trim(checkout.id) ||
    trim(checkout.checkout_id) ||
    trim(checkout.checkoutId) ||
    trim(checkout.session_id);
  if (!checkoutId) return null;
  const status = trim(checkout.status) || "open";
  const continueUrl =
    sanitizeUrl(typeof checkout.continue_url === "string" ? checkout.continue_url : undefined) ??
    sanitizeUrl(typeof checkout.continueUrl === "string" ? checkout.continueUrl : undefined) ??
    sanitizeUrl(typeof checkout.checkout_url === "string" ? checkout.checkout_url : undefined) ??
    sanitizeUrl(typeof checkout.web_url === "string" ? checkout.web_url : undefined) ??
    sanitizeUrl(typeof checkout.url === "string" ? checkout.url : undefined);
  return {
    checkoutId,
    status,
    ...(continueUrl ? { continueUrl } : {}),
    raw,
  };
};

export const createCheckout = async (args: {
  endpoint: string;
  lines: CheckoutLineInput[];
}): Promise<CheckoutSessionResult> => {
  const lines = args.lines
    .map((entry) => ({
      variantId: trim(entry.variantId),
      quantity: Math.max(1, Math.floor(entry.quantity || 1)),
    }))
    .filter((entry) => entry.variantId.length > 0);
  if (lines.length === 0) {
    throw new Error("At least one valid line item is required to create a checkout.");
  }
  const endpoint = sanitizeUrl(args.endpoint);
  if (!endpoint) {
    throw new Error("A valid Checkout MCP endpoint URL is required.");
  }
  const token = await fetchAccessToken();
  const result = await callMcpTool({
    endpoint,
    toolName: "create_checkout",
    authToken: token,
    arguments: {
      lines: lines.map((entry) => ({
        variant_id: entry.variantId,
        quantity: entry.quantity,
      })),
    },
  });
  const session = extractCheckoutSession(result.json ?? result.raw);
  if (!session) {
    throw new Error("Checkout MCP did not return a usable checkout session.");
  }
  return session;
};

export const updateCheckout = async (args: {
  endpoint: string;
  checkoutId: string;
  lines?: CheckoutLineInput[];
}): Promise<CheckoutSessionResult> => {
  const endpoint = sanitizeUrl(args.endpoint);
  if (!endpoint) throw new Error("A valid Checkout MCP endpoint URL is required.");
  const checkoutId = trim(args.checkoutId);
  if (!checkoutId) throw new Error("checkoutId is required to update a checkout.");
  const lines = (args.lines ?? [])
    .map((entry) => ({
      variantId: trim(entry.variantId),
      quantity: Math.max(0, Math.floor(entry.quantity || 0)),
    }))
    .filter((entry) => entry.variantId.length > 0);
  const token = await fetchAccessToken();
  const result = await callMcpTool({
    endpoint,
    toolName: "update_checkout",
    authToken: token,
    arguments: {
      checkout_id: checkoutId,
      ...(lines.length > 0
        ? {
            lines: lines.map((entry) => ({
              variant_id: entry.variantId,
              quantity: entry.quantity,
            })),
          }
        : {}),
    },
  });
  const session = extractCheckoutSession(result.json ?? result.raw);
  if (!session) {
    throw new Error("Checkout MCP did not return a usable checkout session after update.");
  }
  return session;
};

export const cancelCheckout = async (args: {
  endpoint: string;
  checkoutId: string;
}): Promise<{ checkoutId: string; status: string }> => {
  const endpoint = sanitizeUrl(args.endpoint);
  if (!endpoint) throw new Error("A valid Checkout MCP endpoint URL is required.");
  const checkoutId = trim(args.checkoutId);
  if (!checkoutId) throw new Error("checkoutId is required to cancel a checkout.");
  const token = await fetchAccessToken();
  const result = await callMcpTool({
    endpoint,
    toolName: "cancel_checkout",
    authToken: token,
    arguments: { checkout_id: checkoutId },
  });
  const session = extractCheckoutSession(result.json ?? result.raw);
  return {
    checkoutId,
    status: session?.status ?? "canceled",
  };
};

// ---------------------------------------------------------------------------
// Cart-permalink fallback used when Checkout MCP isn't reachable.
//
// Spec: https://shopify.dev/docs/storefronts/themes/architecture/templates/cart#permalinks
// ---------------------------------------------------------------------------

export const buildCartPermalink = (args: {
  merchantOrigin: string;
  lines: CheckoutLineInput[];
}): string | null => {
  const origin = sanitizeUrl(args.merchantOrigin);
  if (!origin) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  const segments = args.lines
    .filter((entry) => isNonEmptyString(entry.variantId) && Number.isFinite(entry.quantity))
    .map(
      (entry) =>
        `${variantIdForCartPermalink(entry.variantId)}:${Math.max(1, Math.floor(entry.quantity))}`,
    );
  if (segments.length === 0) return null;
  return `${base.origin}/cart/${segments.join(",")}`;
};
