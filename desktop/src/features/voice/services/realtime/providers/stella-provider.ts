/**
 * Stella-managed realtime voice provider.
 *
 * The user picks a voice family (OpenAI, xAI, or Inworld) plus a voice
 * id; the Stella backend mints the right kind of session for that family
 * and the renderer dispatches to the right transport based on the
 * `voiceProvider` / `transport` fields in the response.
 *
 * Auth model varies by sub-family:
 *   - openai: backend mints a short-lived OpenAI Realtime ephemeral
 *     `client_secret`. Renderer talks WebRTC SDP directly to OpenAI.
 *   - xai: backend mints a short-lived xAI Voice Agent
 *     `client_secret`. Renderer talks WebSocket directly to xAI.
 *   - inworld: Inworld has no ephemeral token concept (their API key is
 *     used as the Bearer for SDP exchange). To avoid leaking Stella's
 *     org Inworld key, the renderer routes SDP through Stella's backend
 *     SDP-proxy endpoint, authenticated by the user's normal Convex
 *     auth. The org key never enters the renderer.
 *
 * The user does not need a BYOK key in any of these sub-paths.
 */

import { postServiceJson } from "@/infra/http/service-request";
import {
  DEFAULT_INWORLD_REALTIME_MODEL,
  DEFAULT_INWORLD_REALTIME_SPEED,
  DEFAULT_INWORLD_REALTIME_TTS_MODEL,
} from "../../../../../../../runtime/contracts/realtime-voice-catalog";
import { OpenAIWebRTCTransport } from "../transports/openai-webrtc-transport";
import {
  bearerSdpFetcher,
  stellaProxiedSdpFetcher,
} from "../transports/sdp-fetchers";
import { XaiWebSocketTransport } from "../transports/xai-websocket-transport";
import type {
  ProviderModule,
  RealtimeTransportKind,
  VoiceSessionToken,
} from "./types";

const STELLA_INWORLD_SDP_PATH = "/api/voice/inworld/sdp";

const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;

const toConvexConversationId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized;
};

/**
 * Read which voice family Stella should use and which voice id within
 * that family. Both default if missing.
 */
const readStellaVoicePrefs = async (): Promise<{
  voiceProvider: "openai" | "xai" | "inworld";
  voice?: string;
  inworldSpeed?: number;
}> => {
  try {
    const prefs =
      await window.electronAPI?.system?.getLocalModelPreferences?.();
    const sub = prefs?.realtimeVoice?.stellaSubProvider;
    const voiceProvider: "openai" | "xai" | "inworld" =
      sub === "xai" ? "xai" : sub === "inworld" ? "inworld" : "openai";
    const voice = prefs?.realtimeVoice?.voices?.[voiceProvider];
    const inworldSpeed = prefs?.realtimeVoice?.inworldSpeed;
    return {
      voiceProvider,
      voice:
        typeof voice === "string" && voice.trim().length > 0
          ? voice.trim()
          : undefined,
      inworldSpeed:
        typeof inworldSpeed === "number" && Number.isFinite(inworldSpeed)
          ? inworldSpeed
          : undefined,
    };
  } catch {
    return { voiceProvider: "openai" };
  }
};

type StellaSessionResponse = {
  voiceProvider?: "openai" | "xai" | "inworld";
  transport?: RealtimeTransportKind;
  clientSecret?: unknown;
  model?: unknown;
  voice?: unknown;
  expiresAt?: unknown;
  sessionId?: unknown;
  /** Provider-supplied STUN/TURN servers. Inworld returns these. */
  iceServers?: unknown;
};

const normalizeIceServers = (value: unknown): RTCIceServer[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value as RTCIceServer[];
};

const inferTransport = (
  raw: StellaSessionResponse,
  voiceProvider: "openai" | "xai" | "inworld",
): RealtimeTransportKind => {
  if (
    raw.transport === "xai-websocket" ||
    raw.transport === "openai-webrtc" ||
    raw.transport === "inworld-webrtc"
  ) {
    return raw.transport;
  }
  switch (raw.voiceProvider ?? voiceProvider) {
    case "xai":
      return "xai-websocket";
    case "inworld":
      return "inworld-webrtc";
    default:
      return "openai-webrtc";
  }
};

export const stellaProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const convexConversationId = toConvexConversationId(ctx.conversationId);
    const { voiceProvider, voice, inworldSpeed } =
      await readStellaVoicePrefs();

    const body = {
      ...(convexConversationId ? { conversationId: convexConversationId } : {}),
      instructions: ctx.instructions,
      voiceProvider,
      ...(voice ? { voice } : {}),
    };

    const raw = await postServiceJson<StellaSessionResponse>(
      "/api/voice/session",
      body,
      {
        errorMessage: (response) =>
          `Failed to create voice session: ${response.status}`,
      },
    );

    const transport = inferTransport(raw, voiceProvider);

    // Inworld via Stella has no clientSecret — SDP is proxied through
    // the backend, so the renderer never holds the org key. All other
    // paths must ship one.
    const clientSecret =
      transport === "inworld-webrtc"
        ? ""
        : typeof raw.clientSecret === "string"
          ? raw.clientSecret
          : "";
    if (transport !== "inworld-webrtc" && !clientSecret) {
      throw new Error(
        "Stella voice session response did not include a client secret.",
      );
    }

    return {
      provider: "stella",
      transport,
      clientSecret,
      model: typeof raw.model === "string" ? raw.model : "",
      voice:
        typeof raw.voice === "string" && raw.voice.length > 0
          ? raw.voice
          : (voice ?? ""),
      expiresAt:
        typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
      sessionId:
        typeof raw.sessionId === "string" ? raw.sessionId : undefined,
      iceServers: normalizeIceServers(raw.iceServers),
      speed: inworldSpeed,
    };
  },

  createTransport(token, ctx) {
    if (token.transport === "xai-websocket") {
      return new XaiWebSocketTransport({
        clientSecret: token.clientSecret,
        model: token.model,
        voice: token.voice,
        instructions: ctx.instructions,
      });
    }

    if (token.transport === "inworld-webrtc") {
      // Stella's backend proxies the SDP exchange — auth is the user's
      // existing Convex session, not the org Inworld key. ICE servers
      // come from the session response (the backend fetched them from
      // Inworld using the org key on the renderer's behalf).
      return new OpenAIWebRTCTransport({
        provider: "inworld",
        model: token.model,
        sdpFetch: stellaProxiedSdpFetcher(STELLA_INWORLD_SDP_PATH),
        initialSessionConfig: buildInworldSessionConfig({
          model: token.model || DEFAULT_INWORLD_REALTIME_MODEL,
          voice: token.voice,
          instructions: ctx.instructions,
          speed: token.speed,
        }),
        iceServers: token.iceServers,
        waitForIceGathering: true,
        acquireMicBeforeOffer: true,
      });
    }

    return new OpenAIWebRTCTransport({
      provider: "openai",
      model: token.model,
      sdpFetch: bearerSdpFetcher(
        "https://api.openai.com/v1/realtime/calls",
        token.clientSecret,
      ),
    });
  },
};

/**
 * Inworld requires session config to be sent via `session.update` after
 * the data channel opens (their docs example). We assemble the standard
 * shape here so both BYOK and Stella-managed Inworld paths configure
 * the session identically.
 */
export const buildInworldSessionConfig = (opts: {
  model: string;
  voice: string;
  instructions: string;
  /** TTS playback speed. Defaults to DEFAULT_INWORLD_REALTIME_SPEED. */
  speed?: number;
}): Record<string, unknown> => ({
  type: "realtime",
  model: opts.model,
  instructions: opts.instructions,
  output_modalities: ["audio", "text"],
  audio: {
    input: {
      // semantic_vad is "backed by the STT stream" per Inworld's docs,
      // so we set an explicit STT model rather than rely on an implicit
      // default. assemblyai/u3-rt-pro is Inworld's lowest-latency
      // English/multilingual STT (<300ms).
      transcription: {
        model: "assemblyai/u3-rt-pro",
      },
      turn_detection: {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      },
    },
    output: {
      voice: opts.voice,
      model: DEFAULT_INWORLD_REALTIME_TTS_MODEL,
      speed: opts.speed ?? DEFAULT_INWORLD_REALTIME_SPEED,
    },
  },
});
