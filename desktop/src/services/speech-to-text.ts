import { getOrCreateDeviceId } from "./device";
import { createServiceRequest } from "./http/service-request";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export type SpeechToTextContext = Record<string, unknown>;

export type SpeechToTextRequest = {
  audio: Blob;
  language?: string[];
  context?: SpeechToTextContext;
  properties?: Record<string, unknown>;
};

export type SpeechToTextResult = {
  id: string | null;
  text: string;
  detectedLanguage: string | null;
  totalTime: number | null;
  generatedTokens: number | null;
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read audio blob"));
    reader.onloadend = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to encode audio blob"));
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      if (commaIndex < 0) {
        reject(new Error("Failed to encode audio blob"));
        return;
      }
      resolve(reader.result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(blob);
  });
};

export async function transcribeAudio(
  input: SpeechToTextRequest,
): Promise<SpeechToTextResult> {
  if (!(input.audio instanceof Blob) || input.audio.size === 0) {
    throw new Error("audio blob is required");
  }
  if (input.audio.size > MAX_AUDIO_BYTES) {
    throw new Error(`audio exceeds ${MAX_AUDIO_BYTES} byte limit`);
  }

  const [audioBase64, deviceId] = await Promise.all([
    blobToBase64(input.audio),
    getOrCreateDeviceId(),
  ]);

  const { endpoint, headers } = await createServiceRequest("/api/speech-to-text", {
    "Content-Type": "application/json",
    "X-Device-ID": deviceId,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      audio: audioBase64,
      ...(input.language && input.language.length > 0
        ? { language: input.language }
        : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.properties ? { properties: input.properties } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Speech-to-text failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as Partial<SpeechToTextResult>;
  if (typeof result.text !== "string") {
    throw new Error("Speech-to-text response missing text");
  }

  return {
    id: typeof result.id === "string" ? result.id : null,
    text: result.text,
    detectedLanguage:
      typeof result.detectedLanguage === "string" ? result.detectedLanguage : null,
    totalTime: typeof result.totalTime === "number" ? result.totalTime : null,
    generatedTokens:
      typeof result.generatedTokens === "number" ? result.generatedTokens : null,
  };
}
