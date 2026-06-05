/**
 * User-BYOK OpenAI Realtime provider.
 *
 * Token is minted in main-process using the user's stored OpenAI API key
 * (`voiceApi.createOpenAISession`) and the connection uses OpenAI's WebRTC
 * realtime endpoint.
 */

import { OpenAIWebRTCTransport } from "../transports/openai-webrtc-transport";
import { bearerSdpFetcher } from "../transports/sdp-fetchers";
import type {
  ProviderModule,
  ProviderTokenContext,
  VoiceSessionToken,
} from "./types";

const OPENAI_SDP_ENDPOINT = "https://api.openai.com/v1/realtime/calls";

export const buildOpenAIRealtimeSessionConfig = (
  token: Pick<VoiceSessionToken, "model" | "voice">,
  ctx: ProviderTokenContext,
): Record<string, unknown> => ({
  type: "realtime",
  model: token.model,
  instructions: ctx.instructions,
  ...(ctx.tools?.length ? { tools: ctx.tools, tool_choice: "auto" } : {}),
  audio: {
    output: {
      voice: token.voice,
    },
  },
});

export const openaiProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const voiceApi = window.electronAPI?.voice;
    if (!voiceApi) {
      throw new Error("Voice API is not available.");
    }
    const result = await voiceApi.createOpenAISession({
      instructions: ctx.instructions,
      tools: ctx.tools,
    });
    return {
      provider: "openai",
      transport: "openai-webrtc",
      clientSecret: result.clientSecret,
      model: result.model,
      voice: result.voice,
      expiresAt: result.expiresAt,
      sessionId: result.sessionId,
    };
  },

  createTransport(token, ctx) {
    return new OpenAIWebRTCTransport({
      provider: "openai",
      model: token.model,
      sdpFetch: bearerSdpFetcher(OPENAI_SDP_ENDPOINT, token.clientSecret),
      initialSessionConfig: buildOpenAIRealtimeSessionConfig(token, ctx),
    });
  },
};
