import type { RealtimeTransport } from "../transports/types";
import type { RealtimeVoiceProvider } from "../../../../../../../runtime/contracts/local-preferences";

export type RealtimeProviderKey = RealtimeVoiceProvider;

export type RealtimeTransportKind =
  | "openai-webrtc"
  | "xai-websocket"
  | "inworld-webrtc";

export interface VoiceSessionToken {
  /**
   * Which provider authenticated the connection — used for usage
   * reporting and routing. "stella" means the Stella backend minted the
   * token; "openai"/"xai" means the user's BYOK key was used directly.
   */
  provider: RealtimeProviderKey;
  /**
   * Which wire protocol to talk over. The Stella backend may return
   * either an OpenAI-Realtime token (→ webrtc) or an xAI-Realtime token
   * (→ websocket) depending on the user's voice family choice. BYOK
   * paths always pin to their family.
   */
  transport: RealtimeTransportKind;
  /** Short-lived secret for the transport's auth (or raw API key fallback). */
  clientSecret: string;
  /** Server-reported model id, or the requested model as fallback. */
  model: string;
  /** Default voice id selected at token mint time. */
  voice: string;
  /** Unix-seconds expiry, if the provider reports one. */
  expiresAt?: number;
  /** OpenAI-only: returned session id, useful for debugging. */
  sessionId?: string;
  /**
   * STUN/TURN configuration the transport should hand to
   * RTCPeerConnection. Inworld supplies these via
   * `/v1/realtime/ice-servers`; OpenAI doesn't need them.
   */
  iceServers?: RTCIceServer[];
  /**
   * Inworld TTS playback speed multiplier. Only meaningful for the
   * inworld-webrtc transport; other transports ignore it.
   */
  speed?: number;
}

export interface ProviderTokenContext {
  /** Convex conversation id, when available — used by Stella's backend. */
  conversationId?: string;
  /** Full system prompt to inject at session start. */
  instructions: string;
}

export interface ProviderModule {
  /** Fetch an auth token for this provider (typically via main-process IPC). */
  fetchToken(ctx: ProviderTokenContext): Promise<VoiceSessionToken>;
  /** Construct the right transport for this provider's wire protocol. */
  createTransport(
    token: VoiceSessionToken,
    ctx: ProviderTokenContext,
  ): RealtimeTransport;
}
