/**
 * User-BYOK xAI Voice Agent provider.
 *
 * Token is minted in main-process using the user's stored xAI API key
 * (`voiceApi.createXaiSession`). The connection uses xAI's WebSocket
 * realtime endpoint, which is OpenAI-Realtime-compatible at the event
 * level but ships audio in-band rather than over a media track.
 */

import { XaiWebSocketTransport } from "../transports/xai-websocket-transport";
import type { ProviderModule, VoiceSessionToken } from "./types";

export const xaiProvider: ProviderModule = {
  async fetchToken(ctx): Promise<VoiceSessionToken> {
    const voiceApi = window.electronAPI?.voice;
    if (!voiceApi?.createXaiSession) {
      throw new Error("Voice API does not support xAI in this build.");
    }
    const result = await voiceApi.createXaiSession({
      instructions: ctx.instructions,
    });
    return {
      provider: "xai",
      transport: "xai-websocket",
      clientSecret: result.clientSecret,
      model: result.model,
      voice: result.voice,
      expiresAt: result.expiresAt,
    };
  },

  createTransport(token, ctx) {
    return new XaiWebSocketTransport({
      clientSecret: token.clientSecret,
      model: token.model,
      voice: token.voice,
      instructions: ctx.instructions,
    });
  },
};
