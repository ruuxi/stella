import { promises as fs } from "node:fs";
import path from "node:path";

import {
  getImageGenerationPreferences,
  type ImageGenerationProvider,
} from "../preferences/local-preferences.js";
import { getLocalLlmCredential } from "../storage/llm-credentials.js";
import {
  claimImageOperationSubmission,
  markImageOperationSubmitted,
  reserveDurableImageOperation,
  settleImageOperation,
} from "./image-operation-store.js";
import {
  authorizedReferenceAsDataUri,
  detectSupportedImageMimeType,
} from "./image-reference-policy.js";
import { materializeMediaArtifact } from "./media-artifact-store.js";
import type { ManagedImageTerminalResult } from "./managed-image-job.js";
import type { ToolContext, ToolHandlerExtras, ToolResult } from "./types.js";

type LocalImageGenerationInput = {
  args: Record<string, unknown>;
  context: ToolContext;
  extras?: ToolHandlerExtras;
  prompt: string;
  aspectRatio?: string | null;
  referenceImageUrls: string[];
  referenceImagePaths: string[];
};

const HTTP_URL_RE = /^https?:\/\//i;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const abortError = (signal: AbortSignal): Error => {
  const error =
    signal.reason instanceof Error
      ? signal.reason
      : new Error("Image generation was canceled.");
  error.name = "AbortError";
  return error;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true },
    );
  });

const normalizeCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(4, Math.floor(value)))
    : 1;

const normalizeFormat = (value: unknown): "png" | "jpeg" | "webp" => {
  const format = asString(value)?.toLowerCase();
  return format === "jpeg" || format === "jpg"
    ? "jpeg"
    : format === "webp"
      ? "webp"
      : "png";
};

const providerModel = (
  provider: ImageGenerationProvider,
  configured?: string,
): string => {
  const fallback =
    provider === "openai"
      ? "gpt-image-2"
      : provider === "fal"
        ? "fal-ai/flux-2-pro"
        : "openai/gpt-image-2";
  const model = configured?.trim() || fallback;
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};

const openAiSize = (
  size: unknown,
  ratio?: string | null,
): "auto" | "1024x1024" | "1536x1024" | "1024x1536" => {
  if (size && typeof size === "object") {
    const record = size as { width?: unknown; height?: unknown };
    const width = typeof record.width === "number" ? record.width : 0;
    const height = typeof record.height === "number" ? record.height : 0;
    if (width > 0 && height > 0) {
      if (Math.abs(width - height) / Math.max(width, height) < 0.05)
        return "1024x1024";
      return width > height ? "1536x1024" : "1024x1536";
    }
  }
  const match = ratio?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return "auto";
  const value = Number(match[1]) / Number(match[2]);
  return value > 1.08 ? "1536x1024" : value < 0.92 ? "1024x1536" : "1024x1024";
};

const parseError = async (response: Response): Promise<string> =>
  (await response.text().catch(() => "")).trim() ||
  `request failed with status ${response.status}`;

const extractOpenAiImages = (json: unknown): string[] => {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => {
      const image = entry as { b64_json?: unknown; url?: unknown };
      return asString(image.b64_json) ?? asString(image.url);
    })
    .filter((value): value is string => value !== null);
};

const extractFalImages = (json: unknown): string[] => {
  const images = (json as { images?: unknown })?.images;
  if (!Array.isArray(images)) return [];
  return images
    .map((entry) =>
      typeof entry === "string"
        ? asString(entry)
        : asString((entry as { url?: unknown })?.url),
    )
    .filter((value): value is string => value !== null);
};

const imageBytes = async (
  image: string,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (image.startsWith("data:")) {
    const match = image.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) throw new Error("provider returned an invalid image data URI");
    return Buffer.from(match[2], "base64");
  }
  if (!HTTP_URL_RE.test(image)) return Buffer.from(image, "base64");
  const response = await fetch(image, { signal, redirect: "follow" });
  if (!response.ok)
    throw new Error(`image download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};

const saveProviderImages = async (args: {
  images: string[];
  dataDir: string;
  operationId: string;
  signal?: AbortSignal;
  outputFormat: "png" | "jpeg" | "webp";
}) => {
  const artifacts = [];
  for (const [index, image] of args.images.entries()) {
    const extension = args.outputFormat === "jpeg" ? "jpg" : args.outputFormat;
    const expectedMime = `image/${args.outputFormat}`;
    let detectedMime = expectedMime;
    const filePath = path.join(
      args.dataDir,
      "media",
      "outputs",
      `${args.operationId}_${index}.${extension}`,
    );
    const saved = await materializeMediaArtifact({
      filePath,
      signal: args.signal,
      producerTimeoutMs: 60_000,
      validateExisting: async (candidate) =>
        detectSupportedImageMimeType(await fs.readFile(candidate)) ===
        expectedMime,
      producer: async (signal) => {
        const bytes = await imageBytes(image, signal);
        const mimeType = detectSupportedImageMimeType(bytes);
        if (!mimeType)
          throw new Error("provider returned an unsupported or partial image");
        if (mimeType !== expectedMime) {
          throw new Error(
            `provider returned ${mimeType} for requested ${expectedMime}`,
          );
        }
        detectedMime = mimeType;
        return bytes;
      },
    });
    artifacts.push({
      kind: "image" as const,
      index,
      path: saved.path,
      mimeType: detectedMime,
      sizeBytes: saved.sizeBytes,
    });
  }
  return { artifacts, filePaths: artifacts.map((artifact) => artifact.path) };
};

const terminalToolResult = (
  terminal: ManagedImageTerminalResult,
  provider: string,
  model: string,
  prompt: string,
): ToolResult => {
  if (!terminal.ok) {
    return {
      error: terminal.message,
      details: {
        ...(terminal.jobId ? { jobId: terminal.jobId } : {}),
        status: terminal.status,
        provider,
        model,
        error: { code: terminal.code, message: terminal.message },
        reattached: terminal.reattached,
      },
    };
  }
  const details = {
    jobId: terminal.job.jobId,
    capability: terminal.job.capability,
    profile: provider,
    provider,
    model,
    prompt,
    status: "succeeded",
    filePaths: terminal.filePaths,
    artifacts: terminal.artifacts,
    reattached: terminal.reattached,
  };
  return { result: details, details };
};

export const runLocalImageGeneration = async (
  input: LocalImageGenerationInput,
): Promise<ToolResult | null> => {
  const dataDir = input.context.stellaDataDir;
  if (!dataDir) return null;
  const preferences = getImageGenerationPreferences(dataDir);
  if (preferences.provider === "stella") return null;
  const provider = preferences.provider;
  const model = providerModel(provider, preferences.model);
  const apiKey = getLocalLlmCredential(dataDir, provider);
  if (!apiKey) {
    return { error: `Connect ${provider} in Settings to use it for images.` };
  }

  const references = await Promise.all(
    input.referenceImagePaths.map((filePath) =>
      authorizedReferenceAsDataUri(filePath, input.context),
    ),
  );
  references.push(...input.referenceImageUrls);
  const outputFormat = normalizeFormat(input.args.output_format);
  const requestIdentity = {
    route: "byok",
    provider,
    model,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio ?? null,
    size: input.args.size ?? null,
    quality: input.args.quality ?? null,
    outputFormat,
    count: normalizeCount(input.args.num_images),
    references,
  };
  const operation = reserveDurableImageOperation({
    stellaDataDir: dataDir,
    conversationId: input.context.conversationId,
    toolCallId: input.context.requestId,
    requestBody: requestIdentity,
  });
  if (operation.terminalResult) {
    return terminalToolResult(
      operation.terminalResult,
      provider,
      model,
      input.prompt,
    );
  }
  const finish = (result: ManagedImageTerminalResult): ToolResult => {
    settleImageOperation({
      stellaDataDir: dataDir,
      operationId: operation.operationId,
      result,
    });
    return terminalToolResult(result, provider, model, input.prompt);
  };
  const unknown = (cause: string): ToolResult =>
    finish({
      ok: false,
      ...(operation.jobId ? { jobId: operation.jobId } : {}),
      status: "unknown",
      code: "provider_outcome_unknown",
      message: `${provider} may have accepted this image request, but Stella cannot safely reconcile it and will not submit it again.`,
      reason: { cause },
      reattached: operation.reattached,
    });

  if (
    provider === "openai" &&
    references.some((value) => HTTP_URL_RE.test(value))
  ) {
    return finish({
      ok: false,
      status: "failed",
      code: "unsupported_reference",
      message:
        "OpenAI image edits require a local authorized image or a validated image data URI.",
      reattached: operation.reattached,
    });
  }

  let images: string[] = [];
  try {
    if (operation.submissionState === "dispatching") {
      return unknown(
        "desktop restarted after the durable direct-provider claim",
      );
    }
    if (
      provider === "fal" &&
      operation.submissionState === "submitted" &&
      operation.jobId
    ) {
      // The provider request id was durable before restart, so polling is safe.
    } else if (
      !claimImageOperationSubmission({
        stellaDataDir: dataDir,
        operationId: operation.operationId,
      })
    ) {
      return unknown("direct-provider submission claim was already consumed");
    } else if (provider === "openai") {
      const common = {
        model,
        prompt: input.prompt,
        n: normalizeCount(input.args.num_images),
        quality: asString(input.args.quality) ?? "low",
        size: openAiSize(input.args.size, input.aspectRatio),
        output_format: outputFormat,
      };
      let response: Response;
      if (references.length === 0) {
        response = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...common, response_format: "b64_json" }),
          signal: input.extras?.signal,
        });
      } else {
        const form = new FormData();
        for (const [key, value] of Object.entries(common))
          form.append(key, String(value));
        for (const [index, reference] of references.entries()) {
          const match = reference.match(/^data:([^;,]+);base64,(.+)$/s);
          if (!match)
            throw new Error(
              "OpenAI edits require local or data URI references",
            );
          form.append(
            "image",
            new Blob([Buffer.from(match[2], "base64")], { type: match[1] }),
            `reference-${index}.png`,
          );
        }
        response = await fetch("https://api.openai.com/v1/images/edits", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: input.extras?.signal,
        });
      }
      if (!response.ok) {
        return finish({
          ok: false,
          status: "failed",
          code: `provider_${response.status}`,
          message: await parseError(response),
          reattached: false,
        });
      }
      images = extractOpenAiImages(await response.json());
      markImageOperationSubmitted({
        stellaDataDir: dataDir,
        operationId: operation.operationId,
      });
    } else if (provider === "openrouter") {
      const response = await fetch("https://openrouter.ai/api/v1/images", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://stella.sh",
          "X-OpenRouter-Title": "Stella",
        },
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          n: normalizeCount(input.args.num_images),
          quality: asString(input.args.quality) ?? "low",
          output_format: outputFormat,
          ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
          ...(references.length
            ? {
                input_references: references.map((url) => ({
                  type: "image_url",
                  image_url: { url },
                })),
              }
            : {}),
        }),
        signal: input.extras?.signal,
      });
      if (!response.ok) {
        return finish({
          ok: false,
          status: "failed",
          code: `provider_${response.status}`,
          message: await parseError(response),
          reattached: false,
        });
      }
      images = extractOpenAiImages(await response.json());
      markImageOperationSubmitted({
        stellaDataDir: dataDir,
        operationId: operation.operationId,
      });
    } else {
      const endpoint = references.length ? `${model}/edit` : model;
      let requestId = operation.jobId;
      if (!requestId) {
        const response = await fetch(`https://queue.fal.run/${endpoint}`, {
          method: "POST",
          headers: {
            Authorization: `Key ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: input.prompt,
            quality: asString(input.args.quality) ?? "low",
            image_size: input.args.size ?? "auto",
            output_format: outputFormat,
            num_images: normalizeCount(input.args.num_images),
            ...(references.length ? { image_urls: references } : {}),
          }),
          signal: input.extras?.signal,
        });
        if (!response.ok) {
          return finish({
            ok: false,
            status: "failed",
            code: `provider_${response.status}`,
            message: await parseError(response),
            reattached: false,
          });
        }
        const submitted = (await response.json()) as { request_id?: unknown };
        requestId = asString(submitted.request_id) ?? undefined;
        if (!requestId) return unknown("Fal accepted no durable request id");
        markImageOperationSubmitted({
          stellaDataDir: dataDir,
          operationId: operation.operationId,
          providerRequestId: requestId,
        });
      }
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        if (input.extras?.signal?.aborted)
          throw abortError(input.extras.signal);
        const response = await fetch(
          `https://queue.fal.run/${endpoint}/requests/${requestId}`,
          {
            headers: { Authorization: `Key ${apiKey}` },
            signal: input.extras?.signal,
          },
        );
        if (response.ok) {
          images = extractFalImages(await response.json());
          if (images.length) break;
        } else if (response.status >= 400 && response.status < 500) {
          return finish({
            ok: false,
            jobId: requestId,
            status: "failed",
            code: `provider_${response.status}`,
            message: await parseError(response),
            reattached: operation.reattached,
          });
        }
        input.extras?.onUpdate?.({
          details: {
            jobId: requestId,
            status: "running",
            statusText: "Generating image with your Fal account…",
          },
        });
        await sleep(3_000, input.extras?.signal);
      }
      if (!images.length)
        return unknown("Fal did not reach a terminal result within one hour");
    }

    if (!images.length) {
      return finish({
        ok: false,
        status: "failed",
        code: "artifact_missing",
        message: `${provider} completed without an image.`,
        reattached: operation.reattached,
      });
    }
    const saved = await saveProviderImages({
      images,
      dataDir,
      operationId: operation.operationId,
      signal: input.extras?.signal,
      outputFormat,
    });
    const jobId = `local-${provider}-${operation.operationId}`;
    return finish({
      ok: true,
      job: {
        jobId,
        capability: references.length ? "image_edit" : "text_to_image",
        profile: provider,
        status: "succeeded",
        completedAt: Date.now(),
      },
      ...saved,
      reattached: operation.reattached,
    });
  } catch (error) {
    if (input.extras?.signal?.aborted) {
      settleImageOperation({
        stellaDataDir: dataDir,
        operationId: operation.operationId,
        result: {
          ok: false,
          ...(operation.jobId ? { jobId: operation.jobId } : {}),
          status: "canceled",
          code: "canceled",
          message: "Image generation was canceled.",
          reattached: operation.reattached,
        },
      });
      throw abortError(input.extras.signal);
    }
    return unknown(error instanceof Error ? error.message : String(error));
  }
};
