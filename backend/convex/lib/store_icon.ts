import {
  fetchFalResultPayload,
  getFalApiKey,
  submitFalRequest,
} from "../media_fal_webhooks";
import { resolveMediaProfile } from "../media_catalog";
import { isRecord } from "../shared_validators";

const ICON_CAPABILITY_ID = "icon";
const ICON_PROFILE_ID = "default";

/**
 * Total wall-clock budget for a single icon generation. Flux Turbo typically
 * returns in 6-12s; we cap at 30s so a slow run never holds the publish UI
 * spinner for an unbounded amount of time. The publish flow treats a missing
 * icon as a non-fatal degrade and falls back to the gradient + monogram.
 */
const ICON_TIMEOUT_MS = 30_000;
const ICON_POLL_INTERVAL_MS = 1_500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const buildIconPrompt = (args: {
  displayName: string;
  description: string;
  category: "agents" | "stella";
}): string => {
  const role =
    args.category === "agents"
      ? "an AI assistant capability"
      : "a Stella desktop app feature";
  // Apple-leaning visual brief: minimal, flat, friendly, single subject,
  // saturated solid background, no text, no UI chrome. Kept short so Flux
  // doesn't drift into busy compositions.
  return [
    `App-store style icon for ${role} called "${args.displayName.trim()}".`,
    `Concept: ${args.description.trim()}.`,
    "Style: minimal flat vector, single subject centered, soft glow,",
    "vibrant saturated solid background, gentle gradient, rounded forms,",
    "Apple-like clarity, no text, no letters, no UI chrome, no borders.",
    "Square 1024x1024, plenty of padding around the subject.",
  ].join(" ");
};

const extractFirstImageUrl = (output: unknown): string | undefined => {
  if (!isRecord(output)) return undefined;
  const images = output.images;
  if (!Array.isArray(images)) return undefined;
  for (const entry of images) {
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
    if (isRecord(entry) && typeof entry.url === "string" && entry.url.trim()) {
      return entry.url.trim();
    }
  }
  return undefined;
};

/**
 * Generate a square icon for a Store package via FAL's `icon` capability and
 * return the resulting public URL. Polls Fal's response endpoint directly so
 * we don't need a webhook round-trip — this lives inside an action that's
 * already async, and the caller awaits the result before showing the publish
 * draft to the user.
 *
 * Returns `undefined` for any failure mode (no API key, network issue,
 * timeout, malformed output). Icons are decorative; nothing else in the
 * publish path depends on them.
 */
export const generateStoreIconUrl = async (args: {
  displayName: string;
  description: string;
  category: "agents" | "stella";
}): Promise<string | undefined> => {
  const apiKey = getFalApiKey();
  if (!apiKey) return undefined;

  const resolved = resolveMediaProfile(ICON_CAPABILITY_ID, ICON_PROFILE_ID);
  if (!resolved) return undefined;

  // Fal's queue API requires a webhook URL, but we never wait on the webhook —
  // we poll the response_url directly. Pointing webhook at a known invalid
  // path keeps Fal happy without holding a real route hostage. Any webhook
  // delivery failures here are silent because we never observe them.
  const webhookSentinel = "https://stella.invalid/api/media/v1/webhooks/fal";

  let submission;
  try {
    submission = await submitFalRequest({
      apiKey,
      endpointId: resolved.profile.endpointId,
      input: {
        prompt: buildIconPrompt(args),
        // Flux Turbo reads `image_size` rather than aspectRatio; 1024 square
        // matches the default macOS app-icon canvas.
        image_size: { width: 1024, height: 1024 },
        num_images: 1,
        output_format: "png",
      },
      webhookUrl: webhookSentinel,
    });
  } catch (error) {
    console.warn("[store_icon] FAL submission failed", error);
    return undefined;
  }

  const responseUrl = submission.responseUrl;
  if (!responseUrl) {
    return undefined;
  }

  const deadline = Date.now() + ICON_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(ICON_POLL_INTERVAL_MS);
    try {
      const payload = await fetchFalResultPayload({ apiKey, url: responseUrl });
      const imageUrl = extractFirstImageUrl(payload);
      if (imageUrl) {
        return imageUrl;
      }
    } catch {
      // Fal returns 4xx until the job finishes; keep polling until the
      // deadline. We swallow the per-attempt error rather than aborting.
    }
  }
  return undefined;
};
