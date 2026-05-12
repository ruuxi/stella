/**
 * Stella-backend TTS client for the read-aloud surface.
 *
 * One-shot synthesis: POST text → receive an encoded audio buffer
 * (mp3 for OpenAI voices, wav for Inworld). The backend keeps the
 * provider API keys server-side and gates by managed-billing.
 */
import { createServiceRequest } from "@/infra/http/service-request";

export type ReadAloudVoiceFamily = "openai" | "inworld";

export type ReadAloudRequest = {
  text: string;
  voice?: string;
  voiceProvider: ReadAloudVoiceFamily;
  speed?: number;
  signal?: AbortSignal;
};

export type ReadAloudResponse = {
  audio: ArrayBuffer;
  /** MIME type the backend reported (`audio/mpeg`, `audio/wav`, …). */
  contentType: string;
};

const TTS_PATH = "/api/voice/tts";

export async function fetchReadAloudAudio(
  req: ReadAloudRequest,
): Promise<ReadAloudResponse> {
  const { endpoint, headers } = await createServiceRequest(TTS_PATH, {
    "Content-Type": "application/json",
  });
  const body: Record<string, unknown> = {
    text: req.text,
    voiceProvider: req.voiceProvider,
  };
  if (req.voice) body.voice = req.voice;
  if (typeof req.speed === "number" && Number.isFinite(req.speed)) {
    body.speed = req.speed;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Read-aloud TTS failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/mpeg";
  const audio = await response.arrayBuffer();
  return { audio, contentType };
}
