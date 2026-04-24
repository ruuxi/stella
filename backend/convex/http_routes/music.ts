import { GoogleGenAI, MusicGenerationMode } from "@google/genai";
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getUserProviderKey } from "../lib/provider_keys";

const MUSIC_STREAM_PATH = "/api/music/stream";
const MUSIC_KEY_PATH = "/api/music/api-key";
const MUSIC_STREAM_RATE_LIMIT = 10;
const MUSIC_STREAM_RATE_WINDOW_MS = 300_000;
const MUSIC_MODEL = "lyria-3-pro-preview";

type ParsedWeightedPrompt = {
  text: string;
  weight: number;
};

type ParsedMusicGenerationConfig = {
  bpm: number;
  density: number;
  brightness: number;
  guidance: number;
  temperature: number;
  musicGenerationMode?: MusicGenerationMode;
};

type ParsedMusicStreamRequest = {
  weightedPrompts: ParsedWeightedPrompt[];
  musicGenerationConfig: ParsedMusicGenerationConfig;
  promptLabel: string | null;
};

type GeneratedMusicResponse = {
  audio: {
    data: string;
    mimeType: string;
  };
  promptLabel: string | null;
  textParts: string[];
};

const asTrimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const parseMusicStreamRequest = (
  value: unknown,
): ParsedMusicStreamRequest | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const weightedPrompts = Array.isArray(record.weightedPrompts)
    ? record.weightedPrompts
    : null;
  const rawConfig =
    record.musicGenerationConfig &&
    typeof record.musicGenerationConfig === "object"
      ? (record.musicGenerationConfig as Record<string, unknown>)
      : null;

  if (!weightedPrompts?.length || !rawConfig) {
    return null;
  }

  const parsedWeightedPrompts = weightedPrompts
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const prompt = entry as Record<string, unknown>;
      const text = asTrimmedString(prompt.text);
      const weight = asFiniteNumber(prompt.weight);
      if (!text || weight === null || weight === 0) {
        return null;
      }

      return {
        text,
        weight: clamp(weight, -100, 100),
      } satisfies ParsedWeightedPrompt;
    })
    .filter((entry): entry is ParsedWeightedPrompt => entry !== null);

  if (!parsedWeightedPrompts.length) {
    return null;
  }

  const bpm = asFiniteNumber(rawConfig.bpm);
  const density = asFiniteNumber(rawConfig.density);
  const brightness = asFiniteNumber(rawConfig.brightness);
  const guidance = asFiniteNumber(rawConfig.guidance);
  const temperature = asFiniteNumber(rawConfig.temperature);

  if (
    bpm === null ||
    density === null ||
    brightness === null ||
    guidance === null ||
    temperature === null
  ) {
    return null;
  }

  const promptLabel = asTrimmedString(record.promptLabel);
  const musicGenerationMode =
    (rawConfig.musicGenerationMode === MusicGenerationMode.VOCALIZATION ||
      rawConfig.music_generation_mode === MusicGenerationMode.VOCALIZATION)
      ? MusicGenerationMode.VOCALIZATION
      : undefined;

  return {
    weightedPrompts: parsedWeightedPrompts,
    musicGenerationConfig: {
      bpm: clamp(bpm, 55, 145),
      density: clamp(density, 0.05, 0.9),
      brightness: clamp(brightness, 0.1, 0.8),
      guidance: clamp(guidance, 2, 5),
      temperature: clamp(temperature, 0.6, 1.4),
      ...(musicGenerationMode ? { musicGenerationMode } : {}),
    },
    promptLabel,
  };
};

const buildMusicPrompt = ({
  weightedPrompts,
  musicGenerationConfig,
  promptLabel,
}: ParsedMusicStreamRequest): string => {
  const weightedPromptLines = weightedPrompts
    .map((prompt, index) => `${index + 1}. (${prompt.weight}) ${prompt.text}`)
    .join("\n");

  const vocalizationInstruction =
    musicGenerationConfig.musicGenerationMode === MusicGenerationMode.VOCALIZATION
      ? "Include tasteful vocalizations or sung elements if they fit the composition."
      : "Instrumental only. Do not include vocals or lyrics.";

  return [
    "Generate a polished 30-second music clip.",
    promptLabel ? `Title or concept: ${promptLabel}.` : null,
    "Blend these weighted influences into one coherent piece:",
    weightedPromptLines,
    "Target musical characteristics:",
    `- Tempo: about ${musicGenerationConfig.bpm} BPM`,
    `- Density: ${musicGenerationConfig.density}`,
    `- Brightness: ${musicGenerationConfig.brightness}`,
    `- Prompt adherence: ${musicGenerationConfig.guidance}`,
    `- Creative variance: ${musicGenerationConfig.temperature}`,
    `- Vocal mode: ${vocalizationInstruction}`,
    "Return high-quality stereo audio.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
};

const generateMusic = async (args: {
  apiKey: string;
  parsedBody: ParsedMusicStreamRequest;
}): Promise<GeneratedMusicResponse> => {
  const client = new GoogleGenAI({
    apiKey: args.apiKey,
    apiVersion: "v1beta",
  });

  const prompt = buildMusicPrompt(args.parsedBody);

  console.log("[music-generate] Requesting Lyria 3 clip.", {
    model: MUSIC_MODEL,
    promptLabel: args.parsedBody.promptLabel,
    weightedPromptCount: args.parsedBody.weightedPrompts.length,
    musicGenerationMode:
      args.parsedBody.musicGenerationConfig.musicGenerationMode ?? "instrumental",
  });

  const response = await client.models.generateContent({
    model: MUSIC_MODEL,
    contents: prompt,
    config: {
      responseModalities: ["AUDIO", "TEXT"],
    },
  });

  const parts = response.candidates?.flatMap(
    (candidate) => candidate.content?.parts ?? [],
  ) ?? [];

  const textParts = parts
    .map((part) => part.text?.trim() ?? "")
    .filter((text) => text.length > 0);

  const audioPart = parts.find(
    (part) =>
      typeof part.inlineData?.data === "string" &&
      typeof part.inlineData?.mimeType === "string",
  );

  if (!audioPart?.inlineData?.data || !audioPart.inlineData.mimeType) {
    const blockReason =
      response.promptFeedback?.blockReasonMessage ??
      response.promptFeedback?.blockReason ??
      "No audio was returned by Lyria 3.";
    console.error("[music-generate] Missing audio in Lyria response.", {
      blockReason,
      textPartCount: textParts.length,
    });
    throw new Error(
      typeof blockReason === "string" ? blockReason : "No audio was returned by Lyria 3.",
    );
  }

  console.log("[music-generate] Received Lyria 3 clip.", {
    mimeType: audioPart.inlineData.mimeType,
    audioBytesBase64Length: audioPart.inlineData.data.length,
    textPartCount: textParts.length,
  });

  return {
    audio: {
      data: audioPart.inlineData.data,
      mimeType: audioPart.inlineData.mimeType,
    },
    promptLabel: args.parsedBody.promptLabel,
    textParts,
  };
};

export const registerMusicRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [MUSIC_STREAM_PATH, MUSIC_KEY_PATH]);

  http.route({
    path: MUSIC_STREAM_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "music_stream",
            key: identity.tokenIdentifier,
            limit: MUSIC_STREAM_RATE_LIMIT,
            windowMs: MUSIC_STREAM_RATE_WINDOW_MS,
            blockMs: MUSIC_STREAM_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: unknown = null;
        try {
          body = await request.json();
        } catch {
          return errorResponse(400, "Invalid JSON body.", origin);
        }

        const parsedBody = parseMusicStreamRequest(body);
        if (!parsedBody) {
          return errorResponse(
            400,
            "weightedPrompts and musicGenerationConfig are required.",
            origin,
          );
        }

        const apiKey =
          await getUserProviderKey(ctx, identity.tokenIdentifier, "llm:google") ??
          process.env.GOOGLE_AI_API_KEY ??
          null;
        if (!apiKey) {
          return errorResponse(
            503,
            "No Google AI API key configured. Add one in Settings or contact your administrator.",
            origin,
          );
        }

        try {
          const result = await generateMusic({
            apiKey,
            parsedBody,
          });

          return withCors(
            Response.json(result, {
              status: 200,
            }),
            origin,
          );
        } catch (error) {
          console.error("[music-generate] Failed to generate music.", {
            message:
              error instanceof Error ? error.message : "Failed to generate music.",
          });
          return errorResponse(
            502,
            error instanceof Error
              ? error.message
              : "Failed to generate music.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: MUSIC_KEY_PATH,
    method: "POST",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        errorResponse(
          410,
          "Music API keys are no longer exposed to clients. Use /api/music/stream instead.",
          origin,
        ),
      ),
    ),
  });
};
