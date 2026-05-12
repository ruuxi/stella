/**
 * RealtimeTransport — abstraction over the wire protocol used to talk to a
 * Realtime voice provider.
 *
 * Two implementations exist:
 *   - OpenAIWebRTCTransport: RTCPeerConnection + SDP + data channel. Used for
 *     both the Stella-managed OpenAI Realtime path and the user's BYOK
 *     OpenAI key path. WebRTC handles mic capture and speaker playback for
 *     free via the audio track.
 *   - XaiWebSocketTransport: WebSocket + hand-rolled mic capture
 *     (AudioWorklet → 24kHz PCM16 → input_audio_buffer.append) +
 *     hand-rolled playback queue (response.output_audio.delta → scheduled
 *     AudioContext buffer playback).
 *
 * The session class (`voice-session.ts`) only sees this interface — it never
 * touches RTCPeerConnection or WebSocket directly. That keeps provider
 * quirks (event-name differences, WebRTC `truncate` vs WS playback flush,
 * voice/audio-format defaults) pinned to one file per provider.
 */

export type RealtimeTransportProvider = "openai" | "xai" | "inworld";

/**
 * Provider-specific SDP answer fetcher used by the WebRTC transport.
 * Takes the local SDP offer (string) and returns the remote SDP answer.
 * The provider module is responsible for choosing the endpoint, auth
 * scheme, and any proxy/wrapper (e.g. Stella's backend SDP proxy that
 * keeps the org Inworld key server-side).
 */
export type SdpAnswerFetcher = (sdpOffer: string) => Promise<string>;

export interface RealtimeTransportEvents {
  /** Raw JSON event from the server (normalised to OpenAI Realtime shape). */
  onEvent: (event: Record<string, unknown>) => void;
  /** Connection terminated for any reason — session moves to error state. */
  onClose: (reason: string) => void;
}

export interface RealtimeTransport {
  /** Provider identity, for telemetry/usage reporting. */
  readonly provider: RealtimeTransportProvider;
  /** Model id the server reported (or the requested model as a fallback). */
  readonly model: string;

  /** Open the connection. Mic is attached but starts in muted state. */
  connect(events: RealtimeTransportEvents): Promise<void>;

  /** Send a JSON event over the underlying channel. */
  send(event: Record<string, unknown>): void;

  /**
   * Toggle whether the microphone is captured & streamed to the server.
   * Connection stays alive when muted.
   */
  setMicEnabled(enabled: boolean): Promise<void>;

  /**
   * Soft mute applied by the echo guard while assistant audio is playing.
   * Implementations should ramp gain rather than hard-cut.
   */
  applySoftInputMute(muted: boolean): void;

  /** AnalyserNode for mic level visualisation. Null until mic is acquired. */
  getMicAnalyser(): AnalyserNode | null;

  /** AnalyserNode for assistant-output level visualisation. */
  getOutputAnalyser(): AnalyserNode | null;

  /**
   * Stop any currently-playing assistant audio.
   * - WebRTC: cuts the remote audio element (the session also sends
   *   `conversation.item.truncate` for OpenAI to forget what it didn't
   *   actually deliver).
   * - WS: flushes the local PCM playback queue.
   */
  interruptPlayback(): void;

  /** Shut everything down. Idempotent. */
  disconnect(): Promise<void>;
}
