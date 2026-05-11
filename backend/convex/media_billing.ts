import { dollarsToMicroCents } from "./lib/billing_money";
import type { MediaRequestSummary } from "./media_contract";
import {
  isRecord,
  type MediaBillingUnit,
  type MediaMeteredFrom,
} from "./shared_validators";

export type { MediaBillingUnit, MediaMeteredFrom };
export {
  MEDIA_BILLING_UNITS,
  MEDIA_METERED_FROM_VALUES,
} from "./shared_validators";

export type MediaBillingRecord = {
  endpointId: string;
  billingUnit: MediaBillingUnit;
  quantity: number;
  unitPriceUsd: number;
  costMicroCents: number;
  meteredFrom: MediaMeteredFrom;
  note?: string;
};

type UnsupportedMediaBilling = {
  supported: false;
  reason: string;
};

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const getInput = (request: MediaRequestSummary): Record<string, unknown> =>
  isRecord(request.input) ? request.input : {};

const getInputNumber = (
  request: MediaRequestSummary,
  ...fields: string[]
): number | null => {
  const input = getInput(request);
  for (const field of fields) {
    const value = asNumber(input[field]);
    if (value !== null) {
      return value;
    }
  }
  return null;
};

const getInputDurationSeconds = (
  request: MediaRequestSummary,
  fallbackSeconds: number,
): { seconds: number; estimated: boolean } => {
  const input = getInput(request);
  for (const field of ["duration", "duration_seconds", "target_duration"]) {
    const value = input[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return { seconds: value, estimated: false };
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return { seconds: parsed, estimated: false };
      }
    }
  }
  return { seconds: fallbackSeconds, estimated: true };
};

const getInputString = (
  request: MediaRequestSummary,
  ...fields: string[]
): string | null => {
  const input = getInput(request);
  for (const field of fields) {
    const value = asString(input[field]);
    if (value) {
      return value;
    }
  }
  return null;
};

const getInputArrayLength = (
  request: MediaRequestSummary,
  field: string,
): number => {
  const input = getInput(request);
  const value = input[field];
  return Array.isArray(value) ? value.length : 0;
};

const walkObject = (
  value: unknown,
  visitor: (entry: Record<string, unknown>) => void,
  depth = 0,
) => {
  if (depth > 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkObject(entry, visitor, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  visitor(value);
  for (const entry of Object.values(value)) {
    walkObject(entry, visitor, depth + 1);
  }
};

const findMaxNumericField = (value: unknown, field: string): number | null => {
  let max: number | null = null;
  walkObject(value, (entry) => {
    const candidate = asNumber(entry[field]);
    if (candidate === null) {
      return;
    }
    max = max === null ? candidate : Math.max(max, candidate);
  });
  return max;
};

const findFirstNumericField = (
  value: unknown,
  field: string,
): number | null => {
  let found: number | null = null;
  walkObject(value, (entry) => {
    if (found !== null) {
      return;
    }
    found = asNumber(entry[field]);
  });
  return found;
};

const toNonNegativeQuantity = (value: number): number =>
  Math.max(0, Number.isFinite(value) ? value : 0);

const buildBillingRecord = (args: {
  endpointId: string;
  billingUnit: MediaBillingRecord["billingUnit"];
  quantity: number;
  unitPriceUsd: number;
  meteredFrom: MediaBillingRecord["meteredFrom"];
  note?: string;
}): MediaBillingRecord => {
  const quantity = toNonNegativeQuantity(args.quantity);
  return {
    endpointId: args.endpointId,
    billingUnit: args.billingUnit,
    quantity,
    unitPriceUsd: args.unitPriceUsd,
    costMicroCents: dollarsToMicroCents(quantity * args.unitPriceUsd),
    meteredFrom: args.meteredFrom,
    ...(args.note ? { note: args.note } : {}),
  };
};

export const getMediaBillingAdmissionIssue = (args: {
  endpointId: string;
  request: MediaRequestSummary;
}): string | null => {
  switch (args.endpointId) {
    case "fal-ai/elevenlabs/sound-effects/v2":
      if (getInputNumber(args.request, "duration_seconds") === null) {
        return "This endpoint needs duration_seconds so Stella can bill from the actual requested duration.";
      }
      return null;
    default:
      return null;
  }
};

/**
 * Estimate the per-image price for OpenAI's GPT Image 2 family on fal.
 *
 * fal publishes a band ($0.01 low @ 1024×768 → $0.41 high @ 4K) but no
 * per-resolution price table. We approximate with quality-tier × megapixels,
 * calibrated to the documented endpoints of the band:
 *   - low @ 1024×768  (~0.79 MP): 0.012 × 0.79 ≈ $0.01  ✓
 *   - high @ 1024×1024 (~1.05 MP): 0.18 × 1.05 ≈ $0.19  (close to OpenAI parent)
 *   - high @ 3840×2160 (~8.29 MP): 0.18 × 8.29 ≈ $1.49 → clamped to $0.41 below
 *
 * If fal exposes a real per-canonical-size table later, swap this function
 * for an explicit lookup. The note attached to the record marks the rate as
 * an estimate so audit trails stay honest.
 */
const GPT_IMAGE_2_MIN_PRICE_USD = 0.01;
const GPT_IMAGE_2_MAX_PRICE_USD = 0.41;

const estimateGptImage2PricePerImage = (
  request: MediaRequestSummary,
): { unitPriceUsd: number; megapixels: number; quality: string } => {
  const input = getInput(request);
  const quality = (getInputString(request, "quality") ?? "high").toLowerCase();
  const perMp = quality === "low" ? 0.012 : quality === "medium" ? 0.045 : 0.18; // "high" is the documented default

  // Default `landscape_4_3` ≈ 1024×768 (0.79 MP). Without an explicit size,
  // round up slightly so we don't undercharge.
  let megapixels = 0.85;
  const imageSize = input.image_size;
  if (isRecord(imageSize)) {
    const width = asNumber(imageSize.width);
    const height = asNumber(imageSize.height);
    if (width !== null && height !== null) {
      megapixels = Math.max(0.65, (width * height) / 1_000_000);
    }
  }
  const raw = perMp * megapixels;
  const clamped = Math.min(
    GPT_IMAGE_2_MAX_PRICE_USD,
    Math.max(GPT_IMAGE_2_MIN_PRICE_USD, raw),
  );
  return { unitPriceUsd: clamped, megapixels, quality };
};

export const meterCompletedMediaJob = (args: {
  endpointId: string;
  request: MediaRequestSummary;
  output: unknown;
}): MediaBillingRecord | UnsupportedMediaBilling => {
  switch (args.endpointId) {
    case "google/lyria-3-pro-preview":
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "request",
        quantity: 1,
        unitPriceUsd: 0.08,
        meteredFrom: "request",
        note: "Lyria 3 Pro Preview: $0.08 per generated song.",
      });
    case "openai/gpt-image-2":
    case "openai/gpt-image-2/edit": {
      const numImages = Math.max(
        1,
        Math.round(getInputNumber(args.request, "num_images") ?? 1),
      );
      const { unitPriceUsd, megapixels, quality } =
        estimateGptImage2PricePerImage(args.request);
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "image",
        quantity: numImages,
        unitPriceUsd,
        meteredFrom: "request",
        note: `Estimated from quality=${quality}, megapixels=${megapixels.toFixed(2)}; fal does not yet expose a per-size price table.`,
      });
    }
    case "fal-ai/bytedance/seedream/v5/lite/text-to-image": {
      const imageCount = getInputNumber(args.request, "num_images") ?? 1;
      const maxImages = getInputNumber(args.request, "max_images") ?? 1;
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "image",
        quantity:
          Math.max(1, Math.round(imageCount)) *
          Math.max(1, Math.round(maxImages)),
        unitPriceUsd: 0.035,
        meteredFrom: "request",
      });
    }
    case "fal-ai/flux-2/klein/9b":
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "request",
        quantity: 1,
        unitPriceUsd: 0.009,
        meteredFrom: "request",
      });
    case "fal-ai/flux-2/turbo":
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "request",
        quantity: 1,
        unitPriceUsd: 0.003146,
        meteredFrom: "request",
        note: "Fixed 512x512 icon generation request.",
      });
    case "fal-ai/flux-2/klein/9b/edit":
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "request",
        quantity: 1,
        unitPriceUsd: 0.022,
        meteredFrom: "request",
      });
    case "bytedance/seedance-2.0/fast/text-to-video":
    case "bytedance/seedance-2.0/fast/image-to-video": {
      const duration = getInputDurationSeconds(args.request, 5);
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "second",
        quantity: duration.seconds,
        unitPriceUsd: 0.2419,
        meteredFrom: "request",
        ...(duration.estimated
          ? { note: "Estimated from Seedance auto duration fallback." }
          : {}),
      });
    }
    case "bytedance/seedance-2.0/fast/reference-to-video": {
      const duration = getInputDurationSeconds(args.request, 5);
      const includesVideoInput =
        getInputArrayLength(args.request, "video_urls") > 0;
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "second",
        quantity: duration.seconds,
        unitPriceUsd: includesVideoInput ? 0.14515 : 0.2419,
        meteredFrom: "request",
        ...(duration.estimated
          ? { note: "Estimated from Seedance auto duration fallback." }
          : {}),
      });
    }
    case "fal-ai/hyper3d/rodin/v2":
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "request",
        quantity: 1,
        unitPriceUsd: 0.4,
        meteredFrom: "request",
      });
    case "fal-ai/elevenlabs/speech-to-text/scribe-v2": {
      const lastWordEndSeconds = findMaxNumericField(args.output, "end");
      if (lastWordEndSeconds === null) {
        return {
          supported: false,
          reason:
            "Transcription output did not include word or segment end timestamps.",
        };
      }
      const keytermCount = getInputArrayLength(args.request, "keyterms");
      const premiumMultiplier = keytermCount > 0 ? 1.3 : 1;
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "minute",
        quantity: (lastWordEndSeconds / 60) * premiumMultiplier,
        unitPriceUsd: 0.008,
        meteredFrom: "request_and_output",
        ...(keytermCount > 0
          ? { note: "Includes ElevenLabs keyterms premium." }
          : {}),
      });
    }
    case "fal-ai/elevenlabs/sound-effects/v2": {
      const durationSeconds = getInputNumber(args.request, "duration_seconds");
      if (durationSeconds === null) {
        return {
          supported: false,
          reason: "The request did not include duration_seconds.",
        };
      }
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "second",
        quantity: durationSeconds,
        unitPriceUsd: 0.002,
        meteredFrom: "request",
      });
    }
    case "fal-ai/elevenlabs/text-to-dialogue/eleven-v3": {
      const text =
        getInputString(args.request, "text") ?? args.request.prompt ?? "";
      if (!text) {
        return {
          supported: false,
          reason: "The request did not include billable text input.",
        };
      }
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "1000_characters",
        quantity: text.length / 1000,
        unitPriceUsd: 0.1,
        meteredFrom: "request",
      });
    }
    case "fal-ai/sam-audio/visual-separate": {
      const durationSeconds = findFirstNumericField(args.output, "duration");
      if (durationSeconds === null) {
        return {
          supported: false,
          reason: "The output did not include a duration field.",
        };
      }
      const rerankingCandidates = Math.max(
        1,
        Math.round(getInputNumber(args.request, "reranking_candidates") ?? 1),
      );
      const baseThirtySecondUnits = durationSeconds / 30;
      const blendedUnits =
        baseThirtySecondUnits *
        (1 + Math.max(0, rerankingCandidates - 1) * 0.5);
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "30_second_unit",
        quantity: blendedUnits,
        unitPriceUsd: 0.05,
        meteredFrom: "request_and_output",
        ...(rerankingCandidates > 1
          ? { note: "Includes reranking candidate surcharge." }
          : {}),
      });
    }
    case "xai/grok-imagine-video/edit-video": {
      const durationSeconds = findFirstNumericField(args.output, "duration");
      const outputHeight = findFirstNumericField(args.output, "height");
      if (durationSeconds === null || outputHeight === null) {
        return {
          supported: false,
          reason:
            "The edited video output did not include duration and height metadata.",
        };
      }
      const pricePerSecond =
        outputHeight <= 480 ? 0.06 : outputHeight <= 720 ? 0.08 : null;
      if (pricePerSecond === null) {
        return {
          supported: false,
          reason: `Unsupported Grok output height for billing: ${outputHeight}.`,
        };
      }
      return buildBillingRecord({
        endpointId: args.endpointId,
        billingUnit: "second",
        quantity: durationSeconds,
        unitPriceUsd: pricePerSecond,
        meteredFrom: "output",
      });
    }
    default:
      return {
        supported: false,
        reason:
          "No completion-time billing strategy is configured for this provider endpoint.",
      };
  }
};
