/**
 * User-BYOK Inworld Realtime provider.
 *
 * Inworld's Realtime API is OpenAI-Realtime-compatible at the event
 * level, runs over WebRTC, and accepts a raw API key as the Bearer for
 * the SDP exchange (no ephemeral-token concept). In BYOK mode we hand
 * the user's own key to the renderer because it's their key on their
 * machine. (Stella-managed Inworld goes through a backend SDP proxy
 * instead — see stella-provider.ts.)
 *
 * Session config (model / voice / TTS model) is sent client-side via
 * `session.update` after the data channel opens — Inworld does not
 * configure the session at token-mint time the way OpenAI Realtime
 * does. The transport's `initialSessionConfig` hook handles this.
 */

import {
  DEFAULT_INWORLD_REALTIME_MODEL,
  DEFAULT_INWORLD_REALTIME_VOICE,
} from "../../../../../../../runtime/contracts/realtime-voice-catalog";
import { OpenAIWebRTCTransport } from "../transports/openai-webrtc-transport";
import { bearerSdpFetcher } from "../transports/sdp-fetchers";
import { buildInworldSessionConfig } from "./stella-provider";
import type { ProviderModule, VoiceSessionToken } from "./types";

const INWORLD_SDP_ENDPOINT = "https://api.inworld.ai/v1/realtime/calls";

export const inworldProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const voiceApi = window.electronAPI?.voice;
    if (!voiceApi?.createInworldSession) {
      throw new Error("Voice API does not support Inworld in this build.");
    }
    const [result, prefs] = await Promise.all([
      voiceApi.createInworldSession({ instructions: ctx.instructions }),
      window.electronAPI?.system?.getLocalModelPreferences?.().catch(() => null),
    ]);
    const inworldSpeed = prefs?.realtimeVoice?.inworldSpeed;
    return {
      provider: "inworld",
      transport: "inworld-webrtc",
      clientSecret: result.clientSecret,
      model: result.model || DEFAULT_INWORLD_REALTIME_MODEL,
      voice: result.voice || DEFAULT_INWORLD_REALTIME_VOICE,
      iceServers: result.iceServers,
      speed:
        typeof inworldSpeed === "number" && Number.isFinite(inworldSpeed)
          ? inworldSpeed
          : undefined,
    };
  },

  createTransport(token, ctx) {
    return new OpenAIWebRTCTransport({
      provider: "inworld",
      model: token.model,
      sdpFetch: bearerSdpFetcher(INWORLD_SDP_ENDPOINT, token.clientSecret),
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
  },
};
