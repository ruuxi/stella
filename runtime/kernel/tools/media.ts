import { promises as fs } from "node:fs";

import type {
  ToolContext,
  ToolHandler,
  ToolHandlerExtras,
  ToolResult,
} from "./types.js";
import {
  submitAndWaitForManagedImageJob,
  type ManagedImageJobOptions,
} from "./managed-image-job.js";

export const IMAGE_GEN_TOOL_NAME = "image_gen";

type MediaToolOptions = {
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  managedImageJob?: Partial<
    Pick<
      ManagedImageJobOptions,
      | "fetchImpl"
      | "now"
      | "sleep"
      | "timeoutMs"
      | "initialPollMs"
      | "maxPollMs"
      | "artifactGraceMs"
      | "artifactDownloadTimeoutMs"
    >
  >;
};

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const mimeTypeFromExtension = (extension: string): string => {
  switch (extension.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
};

const HTTP_URL_RE = /^https?:\/\//i;

const collectStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = asNonEmptyString(entry);
    if (trimmed) out.push(trimmed);
  }
  return out;
};

const mimeTypeFromPath = (filePath: string): string => {
  const match = filePath.match(/\.([a-z0-9]{2,5})$/i);
  return mimeTypeFromExtension(match?.[1]?.toLowerCase() ?? "png");
};

/** Read a local image file and convert it into a `data:` URI. */
const readLocalImageAsDataUri = async (filePath: string): Promise<string> => {
  const buffer = await fs.readFile(filePath);
  const mimeType = mimeTypeFromPath(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
};

const createImageGenHandler =
  (options: MediaToolOptions): ToolHandler =>
  async (
    args: Record<string, unknown>,
    context: ToolContext,
    extras?: ToolHandlerExtras,
  ): Promise<ToolResult> => {
    const prompt = asNonEmptyString(args.prompt);
    if (!prompt) {
      return { error: "prompt is required." };
    }

    const input: Record<string, unknown> = {};
    const profile = asNonEmptyString(args.profile);
    const aspectRatio =
      asNonEmptyString(args.aspectRatio) ?? asNonEmptyString(args.aspect_ratio);
    const quality = asNonEmptyString(args.quality);
    if (quality) input.quality = quality;
    const outputFormat = asNonEmptyString(args.output_format);
    if (outputFormat) input.output_format = outputFormat;
    const numImages =
      typeof args.num_images === "number"
        ? Math.floor(args.num_images)
        : undefined;
    if (typeof numImages === "number" && Number.isFinite(numImages)) {
      input.num_images = Math.max(1, Math.min(numImages, 4));
    }

    // Optional explicit pixel dimensions. Validate the GPT Image 2 envelope
    // locally so the agent gets a clear error instead of a 4xx from upstream.
    const sizeArg = args.size as
      | { width?: unknown; height?: unknown }
      | undefined;
    if (sizeArg && typeof sizeArg === "object") {
      const width =
        typeof sizeArg.width === "number" ? Math.floor(sizeArg.width) : NaN;
      const height =
        typeof sizeArg.height === "number" ? Math.floor(sizeArg.height) : NaN;
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < 1 ||
        height < 1
      ) {
        return {
          error: "image_gen size requires positive integer width and height.",
        };
      }
      const maxEdge = Math.max(width, height);
      const minEdge = Math.min(width, height);
      const pixelArea = width * height;
      if (maxEdge > 3840) {
        return {
          error: `image_gen size max edge ${maxEdge} exceeds 3840.`,
        };
      }
      if (pixelArea < 655_360 || pixelArea > 8_294_400) {
        return {
          error: `image_gen size pixel area ${pixelArea} is outside 655,360–8,294,400.`,
        };
      }
      if (maxEdge > minEdge * 3) {
        return {
          error: `image_gen size aspect ratio ${maxEdge}:${minEdge} is steeper than 3:1.`,
        };
      }
      input.image_size = { width, height };
    }

    // Reference images: local paths get base64-encoded into data: URIs (so the
    // body photo never lands in Convex storage), remote URLs are passed as-is.
    // Any reference present switches the capability to image_edit (GPT Image 2
    // edit endpoint) which expects an `image_urls` array on the input.
    const referencePaths = collectStringList(args.referenceImagePaths);
    const referenceUrlsRaw = collectStringList(args.referenceImageUrls);
    const referenceUrls: string[] = [];
    for (const url of referenceUrlsRaw) {
      if (!HTTP_URL_RE.test(url) && !url.startsWith("data:")) {
        return {
          error: `referenceImageUrls entry is not a valid http(s)/data URL: ${url}`,
        };
      }
      referenceUrls.push(url);
    }
    let imageUrls: string[] = [];
    if (referencePaths.length > 0) {
      try {
        for (const filePath of referencePaths) {
          imageUrls.push(await readLocalImageAsDataUri(filePath));
        }
      } catch (error) {
        return {
          error: `image_gen failed to read reference image: ${(error as Error).message}`,
        };
      }
    }
    imageUrls.push(...referenceUrls);

    const useImageEdit = imageUrls.length > 0;
    if (useImageEdit) {
      input.image_urls = imageUrls;
    }
    const capability = useImageEdit ? "image_edit" : "text_to_image";

    if (!options.getStellaSiteAuth) {
      return {
        error:
          "image_gen is not available because Stella media auth is not configured in this runtime.",
      };
    }

    const siteAuth = options.getStellaSiteAuth();
    if (!siteAuth) {
      return {
        error:
          "image_gen requires Stella sign-in. Open Stella and finish signing in, then retry.",
      };
    }

    const terminal = await submitAndWaitForManagedImageJob({
      baseUrl: siteAuth.baseUrl,
      authToken: siteAuth.authToken,
      requestBody: {
        capability,
        prompt,
        ...(profile ? { profile } : {}),
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(Object.keys(input).length > 0 ? { input } : {}),
        ...(context.connectorDeliveryTarget
          ? {
              connectorRequestId: context.connectorDeliveryTarget.requestId,
            }
          : {}),
      },
      context,
      extras,
      ...options.managedImageJob,
    });
    if (!terminal.ok) {
      const details = {
        ...(terminal.jobId ? { jobId: terminal.jobId } : {}),
        status: terminal.status,
        error: {
          code: terminal.code,
          message: terminal.message,
          ...(terminal.reason !== undefined ? { reason: terminal.reason } : {}),
        },
        reattached: terminal.reattached,
      };
      return { error: terminal.message, details };
    }

    const details = {
      jobId: terminal.job.jobId,
      capability: terminal.job.capability,
      profile: terminal.job.profile,
      prompt,
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(sizeArg && typeof sizeArg === "object" && input.image_size
        ? { requestedSize: input.image_size }
        : {}),
      ...(typeof input.num_images === "number"
        ? { numImages: input.num_images as number }
        : {}),
      status: "succeeded",
      filePaths: terminal.filePaths,
      artifacts: terminal.artifacts,
      reattached: terminal.reattached,
      ...(typeof terminal.job.completedAt === "number"
        ? { completedAt: terminal.job.completedAt }
        : {}),
    };
    return {
      result: details,
      details,
    };
  };

export const createMediaToolHandlers = (
  options: MediaToolOptions,
): Record<string, ToolHandler> => ({
  [IMAGE_GEN_TOOL_NAME]: createImageGenHandler(options),
});
