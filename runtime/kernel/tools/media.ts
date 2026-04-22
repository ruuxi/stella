import { anyApi } from "convex/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ToolContext,
  ToolHandler,
  ToolHandlerExtras,
  ToolResult,
} from "./types.js";

export const IMAGE_GEN_TOOL_NAME = "image_gen";

export const IMAGE_GEN_JSON_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "Natural-language prompt describing the image to generate.",
    },
    aspect_ratio: {
      type: "string",
      description:
        "Optional aspect ratio like `1:1`, `16:9`, `9:16`, `4:3`, or `3:4`.",
    },
    profile: {
      type: "string",
      enum: ["best", "fast"],
      description: "Optional model profile. Defaults to `best`.",
    },
    quality: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Optional quality hint forwarded to the media backend.",
    },
    output_format: {
      type: "string",
      enum: ["png", "jpeg", "webp"],
      description: "Optional output format. Defaults to provider defaults.",
    },
    num_images: {
      type: "number",
      description: "Optional number of images to request (1-4). Defaults to 1.",
    },
    timeout_ms: {
      type: "number",
      description:
        "Maximum time to wait for completion before returning an error. Defaults to 180000.",
    },
  },
  required: ["prompt"],
} as const;

type MediaToolOptions = {
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  queryConvex?: (
    ref: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

type MediaJobRecord = {
  jobId?: string;
  capability?: string;
  profile?: string;
  status?: string;
  output?: unknown;
  error?: { message?: string } | null;
  request?: { prompt?: string } | null;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(finish, ms);
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const extractImageUrls = (output: unknown): string[] => {
  if (!output || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const images = Array.isArray(record.images) ? record.images : [];
  return images
    .map((entry) =>
      entry && typeof entry === "object"
        ? asNonEmptyString((entry as { url?: unknown }).url)
        : null,
    )
    .filter((value): value is string => Boolean(value));
};

const extensionFromMimeType = (mimeType: string | null): string => {
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
};

const extensionFromUrl = (url: string): string | null => {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
};

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

const downloadImage = async (args: {
  url: string;
  outputDir: string;
  fileStem: string;
  signal?: AbortSignal;
}): Promise<{ filePath: string; mimeType: string }> => {
  const response = await fetch(args.url, {
    headers: { "User-Agent": "StellaDesktop/1.0" },
    redirect: "follow",
    signal: args.signal,
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const mimeType =
    asNonEmptyString(response.headers.get("content-type")) ??
    mimeTypeFromExtension(extensionFromUrl(args.url) ?? "png");
  const extension =
    extensionFromUrl(args.url) ?? extensionFromMimeType(mimeType);
  const filePath = path.join(args.outputDir, `${args.fileStem}.${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  return {
    filePath,
    mimeType: mimeType.startsWith("image/")
      ? mimeType
      : mimeTypeFromExtension(extension),
  };
};

const parseErrorResponse = async (response: Response): Promise<string> => {
  try {
    const json = (await response.json()) as {
      error?: unknown;
      action?: unknown;
    };
    const error = asNonEmptyString(json.error);
    const action = asNonEmptyString(json.action);
    return [error, action].filter(Boolean).join(" ");
  } catch {
    const text = await response.text().catch(() => "");
    return text.trim();
  }
};

const createImageGenHandler = (
  options: MediaToolOptions,
): ToolHandler => async (
  args: Record<string, unknown>,
  context: ToolContext,
  extras?: ToolHandlerExtras,
): Promise<ToolResult> => {
  if (!options.getStellaSiteAuth || !options.queryConvex) {
    return {
      error:
        "image_gen is not available because Stella media auth is not configured in this runtime.",
    };
  }

  const prompt = asNonEmptyString(args.prompt);
  if (!prompt) {
    return { error: "prompt is required." };
  }

  const siteAuth = options.getStellaSiteAuth();
  if (!siteAuth) {
    return {
      error:
        "image_gen requires Stella sign-in. Open Stella and finish signing in, then retry.",
    };
  }

  const timeoutMs = Math.max(
    5_000,
    Math.min(
      typeof args.timeout_ms === "number" ? Math.floor(args.timeout_ms) : 180_000,
      600_000,
    ),
  );
  const pollIntervalMs = 1_500;
  const deadline = Date.now() + timeoutMs;

  const input: Record<string, unknown> = {};
  const profile = asNonEmptyString(args.profile);
  const aspectRatio = asNonEmptyString(args.aspect_ratio);
  const quality = asNonEmptyString(args.quality);
  if (quality) input.quality = quality;
  const outputFormat = asNonEmptyString(args.output_format);
  if (outputFormat) input.output_format = outputFormat;
  const numImages =
    typeof args.num_images === "number" ? Math.floor(args.num_images) : undefined;
  if (typeof numImages === "number" && Number.isFinite(numImages)) {
    input.num_images = Math.max(1, Math.min(numImages, 4));
  }

  let submitResponse: Response;
  try {
    submitResponse = await fetch(
      new URL("/api/media/v1/generate", siteAuth.baseUrl).toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${siteAuth.authToken}`,
          "X-Device-ID": context.deviceId,
        },
        body: JSON.stringify({
          capability: "text_to_image",
          prompt,
          ...(profile ? { profile } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(Object.keys(input).length > 0 ? { input } : {}),
        }),
        signal: extras?.signal,
      },
    );
  } catch (error) {
    return { error: `image_gen submission failed: ${(error as Error).message}` };
  }

  if (!submitResponse.ok) {
    const message = await parseErrorResponse(submitResponse);
    return {
      error:
        message ||
        `image_gen submission failed with status ${submitResponse.status}.`,
    };
  }

  let accepted: { jobId?: unknown; capability?: unknown; profile?: unknown };
  try {
    accepted = (await submitResponse.json()) as {
      jobId?: unknown;
      capability?: unknown;
      profile?: unknown;
    };
  } catch {
    return { error: "image_gen returned an invalid JSON response." };
  }

  const jobId = asNonEmptyString(accepted.jobId);
  if (!jobId) {
    return { error: "image_gen response did not include a jobId." };
  }

  while (Date.now() < deadline) {
    if (extras?.signal?.aborted) {
      return { error: "image_gen was aborted." };
    }

    let job: MediaJobRecord | null = null;
    try {
      const result = await options.queryConvex(
        (anyApi as { media_jobs: { getByJobId: unknown } }).media_jobs.getByJobId,
        { jobId },
      );
      job = (result as MediaJobRecord | null) ?? null;
    } catch (error) {
      return { error: `image_gen polling failed: ${(error as Error).message}` };
    }

    if (job?.status === "succeeded" && job.output !== undefined) {
      const urls = extractImageUrls(job.output);
      if (urls.length === 0) {
        return {
          error:
            "image_gen completed, but the media output did not contain any image URLs.",
        };
      }

      const outputDir = path.join(
        context.stellaRoot ?? process.cwd(),
        "state",
        "media",
        "outputs",
      );
      await fs.mkdir(outputDir, { recursive: true });

      const downloads = [];
      for (let index = 0; index < urls.length; index++) {
        downloads.push(
          await downloadImage({
            url: urls[index]!,
            outputDir,
            fileStem: `${jobId}_${index}`,
            signal: extras?.signal,
          }),
        );
      }

      const markers = downloads
        .map(
          ({ filePath, mimeType }) =>
            `[stella-attach-image] inline=${mimeType} ${filePath}`,
        )
        .join("\n");
      const summary = `Generated ${downloads.length} image${
        downloads.length === 1 ? "" : "s"
      } for "${prompt}".`;
      const details = {
        jobId,
        capability:
          asNonEmptyString(job.capability) ??
          asNonEmptyString(accepted.capability) ??
          "text_to_image",
        profile:
          asNonEmptyString(job.profile) ??
          asNonEmptyString(accepted.profile) ??
          "best",
        prompt,
        filePaths: downloads.map((entry) => entry.filePath),
        output: job.output,
      };
      return {
        result: `${summary}\n${markers}`,
        details,
      };
    }

    if (job?.status === "failed" || job?.status === "canceled") {
      return {
        error:
          asNonEmptyString(job.error?.message) ??
          `image_gen ${job.status}.`,
      };
    }

    try {
      await sleep(pollIntervalMs, extras?.signal);
    } catch {
      return { error: "image_gen was aborted." };
    }
  }

  return {
    error: `image_gen timed out after ${timeoutMs}ms while waiting for job ${jobId}.`,
  };
};

export const createMediaToolHandlers = (
  options: MediaToolOptions,
): Record<string, ToolHandler> => ({
  [IMAGE_GEN_TOOL_NAME]: createImageGenHandler(options),
});
