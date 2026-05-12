/**
 * WebRTC transport for OpenAI-Realtime-compatible providers.
 *
 * Used by every provider whose wire protocol is OpenAI Realtime over
 * WebRTC: the Stella-managed OpenAI path, the user's BYOK OpenAI path,
 * the user's BYOK Inworld path, and the Stella-managed Inworld path
 * (which goes through a backend SDP proxy so the org key never reaches
 * the renderer).
 *
 * Provider-specific bits (SDP endpoint, auth scheme, whether session
 * config is sent at token-mint or via `session.update` on connect) are
 * passed in by the provider module:
 *   - `sdpFetch`: takes the local SDP offer, returns the remote SDP
 *     answer. Provider chooses Bearer-against-public-endpoint vs
 *     Stella-proxied-with-Convex-auth.
 *   - `initialSessionConfig`: optional. Inworld requires session config
 *     to be set after the data channel opens via `session.update`;
 *     OpenAI sets it server-side at token mint, so it leaves this unset.
 *
 * The data channel name is "oai-events" — Inworld uses the same name on
 * purpose since their realtime API is OpenAI-Realtime-compatible.
 */

import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import type {
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportProvider,
  SdpAnswerFetcher,
} from "./types";

const DEFAULT_RTC_CONFIGURATION: RTCConfiguration = {
  // Pre-gather one ICE candidate batch to shorten negotiation time.
  iceCandidatePoolSize: 1,
};

/** Hard cap on how long we'll wait for ICE gathering. */
const ICE_GATHERING_TIMEOUT_MS = 4000;

export interface OpenAIWebRTCTransportOptions {
  provider: RealtimeTransportProvider;
  /** Server-reported model id (or the requested model as a fallback). */
  model: string;
  /** Provider-specific SDP exchange (handles auth + endpoint choice). */
  sdpFetch: SdpAnswerFetcher;
  /**
   * Optional session.update to send once the data channel opens. Used by
   * providers (Inworld) that set session config at runtime rather than
   * at token-mint time.
   */
  initialSessionConfig?: Record<string, unknown>;
  /**
   * Provider-supplied STUN/TURN servers. Inworld returns these from
   * `/v1/realtime/ice-servers`; OpenAI leaves this unset because its
   * media server handles connectivity without client-side ICE.
   */
  iceServers?: RTCIceServer[];
  /**
   * Wait for ICE gathering to complete before POSTing the SDP offer.
   * Required by providers (Inworld) whose SDP endpoint expects a
   * complete offer with candidates already baked in. OpenAI's endpoint
   * does its own ICE negotiation and accepts the pre-gathering offer,
   * so this stays off there to avoid an extra round-trip.
   */
  waitForIceGathering?: boolean;
  /**
   * Acquire the microphone and attach it to the transceiver BEFORE
   * createOffer, so the SDP offer's audio m-line advertises a real
   * sending track (SSRC, crypto, codec params baked in). OpenAI's
   * media server is happy with a placeholder transceiver and a
   * post-SDP replaceTrack; Inworld's WebRTC proxy needs the real
   * track in the initial offer or it never allocates the inbound
   * media path — symptom: WebRTC connects fine, session.update is
   * accepted, but no `input_audio_buffer.speech_started` ever fires
   * no matter how loud you talk.
   *
   * Mute / unmute mid-session continues to work via replaceTrack
   * after this initial attach.
   */
  acquireMicBeforeOffer?: boolean;
}

const waitForIceGatheringComplete = (pc: RTCPeerConnection): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      // Null candidate signals end-of-gathering on some implementations.
      if (!event.candidate) finish();
    };
    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);
    setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
  });

export class OpenAIWebRTCTransport implements RealtimeTransport {
  readonly provider: RealtimeTransportProvider;
  readonly model: string;

  private readonly sdpFetch: SdpAnswerFetcher;
  private readonly initialSessionConfig?: Record<string, unknown>;
  private readonly iceServers?: RTCIceServer[];
  private readonly waitForIceGathering: boolean;
  private readonly acquireMicBeforeOffer: boolean;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private sender: RTCRtpSender | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private remoteStream: MediaStream | null = null;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private inputGateNode: GainNode | null = null;
  private inputDestination: MediaStreamAudioDestinationNode | null = null;
  private processedInputTrack: MediaStreamTrack | null = null;
  private inputSourceNode: MediaStreamAudioSourceNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputMonitorSource: MediaStreamAudioSourceNode | null = null;

  private micLease: SharedMicrophoneLease | null = null;
  private localStream: MediaStream | null = null;
  private inputTrack: MediaStreamTrack | null = null;
  private micEnabled = false;
  private micSyncPromise: Promise<void> = Promise.resolve();
  private destroyed = false;

  private events: RealtimeTransportEvents | null = null;

  constructor(options: OpenAIWebRTCTransportOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.sdpFetch = options.sdpFetch;
    this.initialSessionConfig = options.initialSessionConfig;
    this.iceServers = options.iceServers;
    this.waitForIceGathering = options.waitForIceGathering ?? false;
    this.acquireMicBeforeOffer = options.acquireMicBeforeOffer ?? false;
  }

  async connect(events: RealtimeTransportEvents): Promise<void> {
    this.events = events;

    this.pc = new RTCPeerConnection({
      ...DEFAULT_RTC_CONFIGURATION,
      ...(this.iceServers && this.iceServers.length > 0
        ? { iceServers: this.iceServers }
        : {}),
    });

    const transceiver = this.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });
    this.sender = transceiver.sender;

    this.dc = this.pc.createDataChannel("oai-events");
    this.setupDataChannel();

    this.pc.ontrack = (event) => {
      if (this.destroyed) return;
      const stream = event.streams[0];
      if (stream) this.setupAudioPlayback(stream);
    };

    // Inworld's WebRTC proxy requires the audio m-line in the SDP
    // offer to advertise a real sending track, otherwise no inbound
    // media path is allocated on their side and the user's mic is
    // silently dropped. Acquire + attach BEFORE createOffer so the
    // SDP includes proper SSRC + codec params for our send direction.
    if (this.acquireMicBeforeOffer) {
      this.micEnabled = true;
      await this.preAttachMicrophone();
      if (this.destroyed) return;
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.destroyed) return;

    if (this.waitForIceGathering) {
      await waitForIceGatheringComplete(this.pc);
      if (this.destroyed) return;
    }

    // Once gathering completes, `pc.localDescription.sdp` includes the
    // ICE candidates; `offer.sdp` is the pre-gathering snapshot. Inworld
    // needs the post-gathering SDP. Fall back to `offer.sdp` for the
    // OpenAI path which skips gathering.
    const sdpToSend =
      this.pc.localDescription?.sdp ?? offer.sdp ?? "";

    const answerSdp = await this.sdpFetch(sdpToSend);
    if (this.destroyed) return;

    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    if (this.destroyed) return;

    await this.syncMicState();
  }

  send(event: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(event));
    }
  }

  setMicEnabled(enabled: boolean): Promise<void> {
    this.micEnabled = enabled;
    return this.syncMicState();
  }

  applySoftInputMute(muted: boolean): void {
    if (!this.inputGateNode || !this.audioContext) return;
    const target = muted ? 0 : 1;
    const now = this.audioContext.currentTime;
    this.inputGateNode.gain.cancelScheduledValues(now);
    this.inputGateNode.gain.setTargetAtTime(target, now, 0.015);
  }

  getMicAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  getOutputAnalyser(): AnalyserNode | null {
    return this.outputAnalyser;
  }

  interruptPlayback(): void {
    // WebRTC has no client-side queue to flush. The session emits
    // conversation.item.truncate over the data channel for OpenAI to
    // forget audio it didn't deliver; remote playback stops as the model
    // stops sending audio frames.
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.events = null;

    if (this.dc) {
      try {
        this.dc.close();
      } catch {
        // Already closed.
      }
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // Already closed.
      }
      this.pc = null;
    }

    this.releaseMicrophoneCapture();
    this.sender = null;

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.outputMonitorSource) {
      try {
        this.outputMonitorSource.disconnect();
      } catch {
        // Already disconnected.
      }
      this.outputMonitorSource = null;
    }
    this.outputAnalyser = null;
    this.remoteStream = null;

    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Already closed.
      }
      this.audioContext = null;
      this.analyser = null;
      this.inputGateNode = null;
      this.inputDestination = null;
      this.processedInputTrack = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────

  private setupDataChannel(): void {
    if (!this.dc) return;
    this.dc.onopen = () => {
      if (this.destroyed) return;
      // Providers that configure the session at runtime (Inworld) hand
      // us an initialSessionConfig; OpenAI's path sets session config at
      // token-mint time and leaves this undefined.
      if (this.initialSessionConfig) {
        this.send({
          type: "session.update",
          session: this.initialSessionConfig,
        });
      }
    };
    this.dc.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as Record<string, unknown>;
        this.events?.onEvent(parsed);
      } catch (err) {
        console.debug(
          "[openai-webrtc] Failed to parse data channel message:",
          (err as Error).message,
        );
      }
    };
    this.dc.onclose = () => {
      if (this.destroyed) return;
      this.events?.onClose("Data channel closed");
    };
  }

  private setupAudioPlayback(stream: MediaStream): void {
    if (this.destroyed) return;
    if (this.audioElement) return;

    this.audioElement = new Audio();
    this.audioElement.srcObject = stream;
    this.audioElement.autoplay = true;

    const preferredSpeakerId = localStorage.getItem(
      "stella-preferred-speaker-id",
    );
    if (
      preferredSpeakerId &&
      typeof this.audioElement.setSinkId === "function"
    ) {
      this.audioElement.setSinkId(preferredSpeakerId).catch((err) => {
        console.debug(
          "[openai-webrtc] setSinkId failed, using default output:",
          (err as Error).message,
        );
      });
    }

    this.audioElement.play().catch((err) => {
      console.debug(
        "[openai-webrtc] Audio playback failed:",
        (err as Error).message,
      );
    });

    this.remoteStream = stream;
    this.attachOutputMonitor(stream);
  }

  private setupLocalAudioPipeline(stream: MediaStream): void {
    try {
      if (!this.audioContext) {
        const ctx = new AudioContext();
        this.audioContext = ctx;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;
        this.inputGateNode = ctx.createGain();
        this.inputGateNode.gain.value = 1;
        this.inputDestination = ctx.createMediaStreamDestination();
        this.inputGateNode.connect(this.inputDestination);
        this.processedInputTrack =
          this.inputDestination.stream.getAudioTracks()[0] ?? null;

        if (this.remoteStream) {
          this.attachOutputMonitor(this.remoteStream);
        }
      }
      this.attachLocalInputStream(stream);
    } catch (err) {
      console.debug(
        "[openai-webrtc] Audio pipeline setup failed:",
        (err as Error).message,
      );
    }
  }

  private attachLocalInputStream(stream: MediaStream): void {
    if (!this.audioContext || !this.analyser || !this.inputGateNode) return;
    if (this.inputSourceNode) {
      try {
        this.inputSourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      this.inputSourceNode = null;
    }
    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.analyser);
    source.connect(this.inputGateNode);
    this.inputSourceNode = source;
  }

  private attachOutputMonitor(stream: MediaStream): void {
    if (!this.audioContext) return;
    if (this.outputMonitorSource) {
      try {
        this.outputMonitorSource.disconnect();
      } catch {
        // Already disconnected.
      }
      this.outputMonitorSource = null;
    }
    this.outputAnalyser = this.audioContext.createAnalyser();
    this.outputAnalyser.fftSize = 256;
    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.outputAnalyser);
    this.outputMonitorSource = source;
  }

  private syncMicState(): Promise<void> {
    this.micSyncPromise = this.micSyncPromise
      .catch(() => undefined)
      .then(async () => {
        if (this.destroyed) return;
        if (this.micEnabled) {
          await this.resumeMicrophoneCapture();
          if (!this.micEnabled || this.destroyed) {
            await this.suspendMicrophoneCapture();
          }
          return;
        }
        await this.suspendMicrophoneCapture();
      });
    return this.micSyncPromise;
  }

  private async suspendMicrophoneCapture(): Promise<void> {
    if (!this.inputTrack && !this.localStream && !this.micLease) {
      this.applySoftInputMute(false);
      return;
    }
    if (this.sender) {
      try {
        await this.sender.replaceTrack(null);
      } catch (err) {
        console.debug(
          "[openai-webrtc] Failed to detach microphone track:",
          (err as Error).message,
        );
      }
    }
    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = false;
    }
    this.applySoftInputMute(false);
    this.releaseMicrophoneCapture();
  }

  /**
   * Acquire the shared microphone and attach its track to the
   * transceiver's sender BEFORE the SDP offer is generated. Subsequent
   * mute/unmute toggles use the normal replaceTrack(null|track) path,
   * which keeps the SDP-negotiated media slot alive.
   */
  private async preAttachMicrophone(): Promise<void> {
    if (this.destroyed || !this.sender) return;
    const lease = await acquireSharedMicrophone();
    if (this.destroyed) {
      lease.release();
      return;
    }
    this.micLease = lease;
    this.localStream = lease.stream;
    this.inputTrack = this.localStream.getTracks()[0] ?? null;
    if (!this.inputTrack) {
      this.micLease.release();
      this.micLease = null;
      this.localStream = null;
      throw new Error("No microphone track available");
    }
    this.setupLocalAudioPipeline(this.localStream);
    this.inputTrack.enabled = true;
    try {
      await this.sender.replaceTrack(
        this.processedInputTrack ?? this.inputTrack,
      );
    } catch (err) {
      this.releaseMicrophoneCapture();
      throw err;
    }
  }

  private async resumeMicrophoneCapture(): Promise<void> {
    if (!this.micEnabled || this.destroyed) return;
    if (!this.sender) return;

    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = true;
      return;
    }

    const lease = await acquireSharedMicrophone();
    if (!this.micEnabled || this.destroyed) {
      lease.release();
      return;
    }
    this.micLease = lease;
    this.localStream = lease.stream;
    this.inputTrack = this.localStream.getTracks()[0] ?? null;
    if (!this.inputTrack) {
      this.micLease.release();
      this.micLease = null;
      this.localStream = null;
      throw new Error("No microphone track available");
    }

    this.setupLocalAudioPipeline(this.localStream);
    this.inputTrack.enabled = true;

    try {
      await this.sender.replaceTrack(
        this.processedInputTrack ?? this.inputTrack,
      );
    } catch (err) {
      this.releaseMicrophoneCapture();
      throw err;
    }
  }

  private releaseMicrophoneCapture(): void {
    if (this.inputSourceNode) {
      try {
        this.inputSourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      this.inputSourceNode = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.micLease) {
      this.micLease.release();
      this.micLease = null;
    }
    this.inputTrack = null;
  }
}
