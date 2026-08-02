/**
 * Single source of truth for provider/route-aware vision image input limits.
 *
 * Model providers each cap image inputs differently (max long edge, max
 * base64 byte size, per-request image counts). Historically Stella resized
 * every model-bound image with one blunt global profile (2000px long edge,
 * 4.5MB, JPEG quality 80), which both *over-compressed* on generous providers
 * (Anthropic's newest models accept a 2576px long edge and 10MB per image)
 * and mislabeled its own constants (three different files each claimed a
 * different "Anthropic per-image limit": 4.5MB, 5MB, and 10MB).
 *
 * This module resolves the caps from the *resolved target provider/model* so
 * an image reaches each model at the best quality that provider actually
 * supports, while never exceeding a provider's hard ceiling. It is a pure,
 * dependency-free module in the `ai` layer (no `kernel` imports) so both the
 * `ai` send boundary and the `kernel` resize step can share one definition.
 *
 * Verified against provider docs (2026-07):
 *   - Anthropic Messages API: max dimensions 8000x8000; high-resolution-tier
 *     models (Opus 4.7/4.8, Sonnet 5, Fable 5, Mythos 5) accept up to a
 *     2576px long edge, standard-tier models up to 1568px; larger images are
 *     downscaled server-side. Max size 10MB base64 per image on the direct
 *     API and claude.ai, 5MB on Amazon Bedrock and Google Vertex. Requests
 *     with >20 image/document blocks require each image to be <=2000px.
 *   - OpenAI (GPT-5.x): `high` detail allows a 2048px max dimension; `original`
 *     allows up to a 6000px max dimension. Up to 512MB total request payload.
 *   - Google Gemini: images are scaled/padded to a 3072x3072 maximum;
 *     generous inline byte budget (100MB inline file limit).
 *   - OpenRouter / Fireworks / other gateways inherit the underlying model's
 *     limits; resolved by the underlying provider family when known, else a
 *     conservative safe fallback.
 */

/** Resize/encode caps consumed by `resizeImage` (kernel/shared/image-resize). */
export interface ImageCaps {
  /** Max output width in pixels. */
  maxWidth: number;
  /** Max output height in pixels. */
  maxHeight: number;
  /** Max encoded base64 payload in bytes. */
  maxBytes: number;
  /** Starting JPEG quality when a lossy re-encode is unavoidable. */
  jpegQuality: number;
}

/** The resolved target an image is being prepared for. */
export interface ImageCapTarget {
  /** Model registry provider id (e.g. "anthropic", "openai", "google"). */
  provider?: string;
  /** Model registry api id (e.g. "anthropic-messages", "bedrock-converse-stream"). */
  api?: string;
  /** Resolved model id, used to distinguish Anthropic resolution tiers. */
  modelId?: string;
  /** Number of images in the same request (drives the many-image clamp). */
  imageCount?: number;
  /** Legacy attach marker requesting native resolution up to the hard ceiling. */
  detailOriginal?: boolean;
}

// --- Reconciled Anthropic per-image byte caps (single source of truth) ---

/**
 * Anthropic's documented per-image base64 ceiling on the direct API (and
 * claude.ai). This is the true hard cap the wire rejects above; it replaces
 * the previously-divergent 4.5MB/5MB/10MB constants scattered across the
 * resize, send-boundary, and spill modules.
 */
export const ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;

/** Anthropic's per-image base64 ceiling on Amazon Bedrock and Google Vertex. */
export const ANTHROPIC_BEDROCK_VERTEX_MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

// --- Long-edge tiers ---

/** Anthropic high-resolution-tier long edge (Opus 4.7/4.8, Sonnet 5, ...). */
export const ANTHROPIC_HIGH_RES_MAX_EDGE = 2576;
/** Anthropic standard-tier long edge (older Claude models). */
export const ANTHROPIC_STANDARD_MAX_EDGE = 1568;
/** Anthropic absolute max dimension (either axis). */
export const ANTHROPIC_HARD_MAX_EDGE = 8000;

/** OpenAI `high` detail max dimension. */
export const OPENAI_MAX_EDGE = 2048;
/** OpenAI `original` detail max dimension (GPT-5.x). */
export const OPENAI_ORIGINAL_MAX_EDGE = 6000;

/** Google Gemini scales/pads to this maximum. */
export const GOOGLE_MAX_EDGE = 3072;

// --- Many-image request rule (Anthropic: >20 blocks => each <=2000px) ---

export const MANY_IMAGE_THRESHOLD = 20;
export const MANY_IMAGE_MAX_EDGE = 2000;

/**
 * Conservative fallback for unknown routes: a 2048px long edge (fits OpenAI
 * `high` and stays under every mainstream provider's ceiling) and a 4.5MB
 * byte budget (headroom under the tightest mainstream cap, Bedrock/Vertex's
 * 5MB). Lossless PNG is still preferred first by the resizer; the byte budget
 * only forces a lossy pass when PNG can't fit.
 */
export const SAFE_FALLBACK_MAX_EDGE = 2048;
export const SAFE_FALLBACK_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

/**
 * Byte budget to aim for below the direct-API hard cap: staying a margin under
 * 10MB avoids an image passing the resizer only to trip the send-boundary
 * guard at exactly the wire limit.
 */
const ANTHROPIC_DIRECT_RESIZE_MAX_BYTES = Math.floor(9.5 * 1024 * 1024);
const GENEROUS_RESIZE_MAX_BYTES = Math.floor(9.5 * 1024 * 1024);
const BEDROCK_VERTEX_RESIZE_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

/** Default starting JPEG quality: keep text legible, only step down to fit. */
export const DEFAULT_JPEG_QUALITY = 90;

const normalize = (value: string | undefined): string =>
  value?.trim().toLowerCase() ?? "";

/**
 * Anthropic ships new models on the high-resolution tier and only older
 * families (Claude 2.x, Claude 3.x incl. 3.5/3.7, Claude Instant) on the
 * standard tier. Default unknown/newer ids to high-res so we don't needlessly
 * cap a modern model at 1568px; only demote clearly-legacy ids. (Sending a
 * standard-tier model a slightly-too-large image is non-fatal — Anthropic
 * downscales server-side — so biasing toward quality is safe.)
 */
export const isAnthropicStandardTierModel = (modelId: string): boolean => {
  const id = normalize(modelId);
  if (!id) return false;
  // Opus 4.x / Sonnet 4.5+ / Sonnet 5 / Fable 5 / Mythos 5 are high-res.
  if (/opus-?4|sonnet-?4-5|sonnet-?4\.5|sonnet-?5|fable|mythos/.test(id)) {
    return false;
  }
  return /claude-?2|claude-?3|claude-?instant|-3-5-|-3\.5-|-3-7-|-3\.7-/.test(
    id,
  );
};

const isBedrockOrVertexTarget = (provider: string, api: string): boolean =>
  provider === "amazon-bedrock" ||
  provider === "google-vertex" ||
  api === "bedrock-converse-stream" ||
  api === "google-vertex";

const anthropicByteCap = (
  provider: string,
  api: string,
  detailOriginal: boolean,
): { resize: number; hard: number } => {
  if (isBedrockOrVertexTarget(provider, api)) {
    return {
      resize: BEDROCK_VERTEX_RESIZE_MAX_BYTES,
      hard: ANTHROPIC_BEDROCK_VERTEX_MAX_IMAGE_BASE64_BYTES,
    };
  }
  return {
    resize: detailOriginal
      ? ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES
      : ANTHROPIC_DIRECT_RESIZE_MAX_BYTES,
    hard: ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES,
  };
};

const isAnthropicFamily = (provider: string, api: string): boolean =>
  provider === "anthropic" ||
  provider === "amazon-bedrock" ||
  provider === "google-vertex" ||
  api === "anthropic-messages" ||
  api === "bedrock-converse-stream" ||
  api === "google-vertex";

const isOpenAIFamily = (provider: string, api: string): boolean =>
  provider === "openai" ||
  provider === "openai-codex" ||
  provider === "azure-openai-responses" ||
  api.startsWith("openai-") ||
  api === "azure-openai-responses";

const isGoogleFamily = (provider: string, api: string): boolean =>
  provider === "google" || api === "google-generative-ai";

/**
 * Resolve the resize/encode caps for the given target. Falls back to a safe
 * conservative profile when the provider is unknown. `detailOriginal` raises
 * the caps to the provider's hard ceiling so a legacy `detail=original` read
 * read keeps native resolution (still bounded so the request can't fail).
 */
export const resolveImageCaps = (target: ImageCapTarget = {}): ImageCaps => {
  const provider = normalize(target.provider);
  const api = normalize(target.api);
  const detailOriginal = target.detailOriginal ?? false;

  let maxEdge = SAFE_FALLBACK_MAX_EDGE;
  let maxBytes = SAFE_FALLBACK_MAX_BYTES;

  if (isAnthropicFamily(provider, api)) {
    const bytes = anthropicByteCap(provider, api, detailOriginal);
    maxBytes = bytes.resize;
    if (detailOriginal) {
      maxEdge = ANTHROPIC_HARD_MAX_EDGE;
    } else {
      maxEdge = isAnthropicStandardTierModel(target.modelId ?? "")
        ? ANTHROPIC_STANDARD_MAX_EDGE
        : ANTHROPIC_HIGH_RES_MAX_EDGE;
    }
  } else if (isOpenAIFamily(provider, api)) {
    maxEdge = detailOriginal ? OPENAI_ORIGINAL_MAX_EDGE : OPENAI_MAX_EDGE;
    maxBytes = GENEROUS_RESIZE_MAX_BYTES;
  } else if (isGoogleFamily(provider, api)) {
    maxEdge = GOOGLE_MAX_EDGE;
    maxBytes = GENEROUS_RESIZE_MAX_BYTES;
  } else if (detailOriginal) {
    // Unknown provider but original requested: keep the fallback dimension as
    // a hard ceiling and lift the byte budget so a complete original passes
    // through untouched when it already fits.
    maxBytes = GENEROUS_RESIZE_MAX_BYTES;
  }

  // Anthropic's stricter many-image rule (and a safe clamp everywhere else):
  // a request carrying more than 20 images caps each image at 2000px.
  const imageCount = target.imageCount ?? 0;
  if (imageCount > MANY_IMAGE_THRESHOLD) {
    maxEdge = Math.min(maxEdge, MANY_IMAGE_MAX_EDGE);
  }

  return {
    maxWidth: maxEdge,
    maxHeight: maxEdge,
    maxBytes,
    jpegQuality: DEFAULT_JPEG_QUALITY,
  };
};

/** The per-image hard byte cap for a target, for the send-boundary/spill guards. */
export const maxInlineImageBase64Bytes = (
  target: ImageCapTarget = {},
): number => {
  const provider = normalize(target.provider);
  const api = normalize(target.api);
  if (isAnthropicFamily(provider, api)) {
    return anthropicByteCap(provider, api, false).hard;
  }
  return ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES;
};
