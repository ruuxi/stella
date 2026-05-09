import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  getImageGenerationPreferences,
  type ImageGenerationProvider,
} from "../preferences/local-preferences.js";
import { getLocalLlmCredential } from "../storage/llm-credentials.js";
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

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const extensionFromFormat = (format: string): string => {
  const normalized = format.toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "jpg";
  if (normalized === "webp") return "webp";
  return "png";
};

const mimeTypeFromExtension = (extension: string): string => {
  switch (extension.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
};

const mimeTypeFromPath = (filePath: string): string => {
  const match = filePath.match(/\.([a-z0-9]{2,5})$/i);
  return mimeTypeFromExtension(match?.[1] ?? "png");
};

const readLocalImageAsDataUri = async (filePath: string): Promise<string> => {
  const buffer = await fs.readFile(filePath);
  return `data:${mimeTypeFromPath(filePath)};base64,${buffer.toString("base64")}`;
};

const dataUriToBuffer = (uri: string): { buffer: Buffer; mimeType: string } => {
  const match = uri.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image data URI.");
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
};

const fetchJson = async (
  url: string,
  init: RequestInit,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> => {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: text.trim() || `request failed with status ${response.status}.`,
    };
  }
  try {
    return { ok: true, json: await response.json() };
  } catch {
    return { ok: false, error: "request returned invalid JSON." };
  }
};

const normalizeNumImages = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(4, Math.floor(value)));
};

const normalizeOutputFormat = (value: unknown): string => {
  const format = asNonEmptyString(value)?.toLowerCase();
  if (format === "jpg" || format === "jpeg") return "jpeg";
  if (format === "webp") return "webp";
  return "png";
};

const openAiSizeFor = (
  sizeArg: unknown,
  aspectRatio: string | null | undefined,
): "auto" | "1024x1024" | "1536x1024" | "1024x1536" => {
  if (sizeArg && typeof sizeArg === "object") {
    const size = sizeArg as { width?: unknown; height?: unknown };
    const width = typeof size.width === "number" ? size.width : 0;
    const height = typeof size.height === "number" ? size.height : 0;
    if (width > 0 && height > 0) {
      if (Math.abs(width - height) / Math.max(width, height) < 0.05) {
        return "1024x1024";
      }
      return width > height ? "1536x1024" : "1024x1536";
    }
  }
  if (!aspectRatio) return "auto";
  const match = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return "auto";
  const ratio = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(ratio)) return "auto";
  if (ratio > 1.08) return "1536x1024";
  if (ratio < 0.92) return "1024x1536";
  return "1024x1024";
};

const falImageSizeFor = (
  sizeArg: unknown,
  aspectRatio: string | null | undefined,
): unknown => {
  if (sizeArg && typeof sizeArg === "object") {
    const size = sizeArg as { width?: unknown; height?: unknown };
    const width = typeof size.width === "number" ? Math.floor(size.width) : 0;
    const height =
      typeof size.height === "number" ? Math.floor(size.height) : 0;
    if (width > 0 && height > 0) return { width, height };
  }
  if (!aspectRatio) return "auto";
  const match = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return "auto";
  const ratio = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(ratio)) return "auto";
  if (ratio > 1.08) return { width: 1536, height: 1024 };
  if (ratio < 0.92) return { width: 1024, height: 1536 };
  return { width: 1024, height: 1024 };
};

const stripProviderPrefix = (
  provider: ImageGenerationProvider,
  model: string | undefined,
): string => {
  if (!model) {
    if (provider === "openai") return "gpt-image-1.5";
    return "openai/gpt-image-2";
  }
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};

const collectReferenceDataUrls = async (
  localPaths: readonly string[],
  urls: readonly string[],
): Promise<string[]> => {
  const dataUrls: string[] = [];
  for (const filePath of localPaths) {
    dataUrls.push(await readLocalImageAsDataUri(filePath));
  }
  dataUrls.push(...urls);
  return dataUrls;
};

const referenceToBlobInfo = async (
  reference: string,
): Promise<{ buffer: Buffer; mimeType: string }> => {
  if (reference.startsWith("data:")) {
    return dataUriToBuffer(reference);
  }
  if (HTTP_URL_RE.test(reference)) {
    const response = await fetch(reference);
    if (!response.ok) {
      throw new Error(`failed to fetch reference image ${reference}.`);
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType:
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        "image/png",
    };
  }
  return dataUriToBuffer(await readLocalImageAsDataUri(reference));
};

const saveImages = async (
  stellaRoot: string,
  jobId: string,
  outputFormat: string,
  images: readonly string[],
): Promise<string[]> => {
  const extension = extensionFromFormat(outputFormat);
  const outputDir = path.join(stellaRoot, "state", "media", "outputs");
  await fs.mkdir(outputDir, { recursive: true });
  const filePaths: string[] = [];
  for (const [index, image] of images.entries()) {
    let buffer: Buffer;
    if (image.startsWith("data:")) {
      buffer = dataUriToBuffer(image).buffer;
    } else if (HTTP_URL_RE.test(image)) {
      const response = await fetch(image);
      if (!response.ok) {
        throw new Error(`failed to download generated image ${index + 1}.`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      buffer = Buffer.from(image, "base64");
    }
    const filePath = path.join(outputDir, `${jobId}-${index + 1}.${extension}`);
    await fs.writeFile(filePath, buffer);
    filePaths.push(filePath);
  }
  return filePaths;
};

const extractOpenAiImages = (json: unknown): string[] => {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => {
      const record = entry as { b64_json?: unknown; url?: unknown };
      return asNonEmptyString(record.b64_json) ?? asNonEmptyString(record.url);
    })
    .filter((value): value is string => Boolean(value));
};

const runOpenAi = async (
  input: LocalImageGenerationInput,
  apiKey: string,
  model: string,
  outputFormat: string,
): Promise<string[] | { error: string }> => {
  const common = {
    model,
    prompt: input.prompt,
    quality: asNonEmptyString(input.args.quality) ?? "low",
    size: openAiSizeFor(input.args.size, input.aspectRatio),
    n: normalizeNumImages(input.args.num_images),
    response_format: "b64_json",
    output_format: outputFormat,
  };
  const references = await collectReferenceDataUrls(
    input.referenceImagePaths,
    input.referenceImageUrls,
  );
  if (references.length === 0) {
    const response = await fetchJson(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(common),
        signal: input.extras?.signal,
      },
    );
    if (!response.ok) return { error: response.error };
    return extractOpenAiImages(response.json);
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(common)) {
    form.append(key, String(value));
  }
  for (const [index, reference] of references.entries()) {
    const image = await referenceToBlobInfo(reference);
    form.append(
      "image",
      new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }),
      `reference-${index + 1}.png`,
    );
  }
  const response = await fetchJson("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: input.extras?.signal,
  });
  if (!response.ok) return { error: response.error };
  return extractOpenAiImages(response.json);
};

const extractFalImages = (json: unknown): string[] => {
  const images = (json as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : asNonEmptyString((entry as { url?: unknown }).url),
    )
    .filter((value): value is string => Boolean(value));
};

const runFal = async (
  input: LocalImageGenerationInput,
  apiKey: string,
  endpoint: string,
  outputFormat: string,
): Promise<string[] | { error: string }> => {
  const references = await collectReferenceDataUrls(
    input.referenceImagePaths,
    input.referenceImageUrls,
  );
  const endpointId = references.length > 0 ? `${endpoint}/edit` : endpoint;
  const inputBody: Record<string, unknown> = {
    prompt: input.prompt,
    quality: asNonEmptyString(input.args.quality) ?? "low",
    image_size: falImageSizeFor(input.args.size, input.aspectRatio),
    output_format: outputFormat,
    num_images: normalizeNumImages(input.args.num_images),
  };
  if (references.length > 0) inputBody.image_urls = references;
  const submit = await fetchJson(`https://queue.fal.run/${endpointId}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(inputBody),
    signal: input.extras?.signal,
  });
  if (!submit.ok) return { error: submit.error };
  const submitted = submit.json as {
    response_url?: unknown;
    request_id?: unknown;
  };
  const responseUrl =
    asNonEmptyString(submitted.response_url) ??
    (asNonEmptyString(submitted.request_id)
      ? `https://queue.fal.run/${endpointId}/requests/${submitted.request_id}`
      : null);
  if (!responseUrl) return { error: "fal did not return a response URL." };

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await fetchJson(responseUrl, {
      method: "GET",
      headers: { Authorization: `Key ${apiKey}` },
      signal: input.extras?.signal,
    });
    if (result.ok) {
      const images = extractFalImages(result.json);
      if (images.length > 0) return images;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { error: "fal image generation timed out." };
};

const extractOpenRouterImages = (json: unknown): string[] => {
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  const images: string[] = [];
  for (const choice of choices) {
    const message = (choice as { message?: unknown }).message as
      | { images?: unknown; content?: unknown }
      | undefined;
    if (!message) continue;
    if (Array.isArray(message.images)) {
      for (const image of message.images) {
        const url = asNonEmptyString(
          (image as { image_url?: { url?: unknown } }).image_url?.url,
        );
        if (url) images.push(url);
      }
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const record = part as {
          type?: unknown;
          image_url?: { url?: unknown };
        };
        if (record.type === "image_url") {
          const url = asNonEmptyString(record.image_url?.url);
          if (url) images.push(url);
        }
      }
    }
  }
  return images;
};

const runOpenRouter = async (
  input: LocalImageGenerationInput,
  apiKey: string,
  model: string,
): Promise<string[] | { error: string }> => {
  const references = await collectReferenceDataUrls(
    input.referenceImagePaths,
    input.referenceImageUrls,
  );
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: input.prompt },
    ...references.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  const response = await fetchJson(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        modalities: ["image", "text"],
        messages: [{ role: "user", content }],
      }),
      signal: input.extras?.signal,
    },
  );
  if (!response.ok) return { error: response.error };
  return extractOpenRouterImages(response.json);
};

export const runLocalImageGeneration = async (
  input: LocalImageGenerationInput,
): Promise<ToolResult | null> => {
  const stellaRoot = input.context.stellaRoot;
  if (!stellaRoot) return null;

  const preferences = getImageGenerationPreferences(stellaRoot);
  if (preferences.provider === "stella") return null;

  const apiKey = getLocalLlmCredential(stellaRoot, preferences.provider);
  if (!apiKey) {
    return {
      error: `Connect ${preferences.provider} in Settings to use it for images.`,
    };
  }

  const outputFormat = normalizeOutputFormat(input.args.output_format);
  const providerModel = stripProviderPrefix(
    preferences.provider,
    preferences.model,
  );
  const generated =
    preferences.provider === "openai"
      ? await runOpenAi(input, apiKey, providerModel, outputFormat)
      : preferences.provider === "fal"
        ? await runFal(input, apiKey, providerModel, outputFormat)
        : await runOpenRouter(input, apiKey, providerModel);
  if ("error" in generated) {
    return {
      error: `image_gen ${preferences.provider} failed: ${generated.error}`,
    };
  }
  if (generated.length === 0) {
    return {
      error: `image_gen ${preferences.provider} did not return an image.`,
    };
  }

  const jobId = `local-${preferences.provider}-${randomUUID()}`;
  let filePaths: string[];
  try {
    filePaths = await saveImages(stellaRoot, jobId, outputFormat, generated);
  } catch (error) {
    return {
      error: `image_gen saved no images: ${(error as Error).message}`,
    };
  }
  const capability =
    input.referenceImagePaths.length > 0 || input.referenceImageUrls.length > 0
      ? "image_edit"
      : "text_to_image";
  return {
    result: `image_gen ${preferences.provider} created ${filePaths.length} image${filePaths.length === 1 ? "" : "s"}.`,
    details: {
      jobId,
      capability,
      profile: preferences.provider,
      provider: preferences.provider,
      model: providerModel,
      prompt: input.prompt,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      filePaths,
      status: "succeeded",
    },
  };
};
