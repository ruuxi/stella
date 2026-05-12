/**
 * Realtime voice session — public facade.
 *
 * The orchestration class lives in `./realtime/voice-session.ts` so that
 * provider-specific transports (WebRTC for OpenAI, WebSocket for xAI) can
 * be swapped without touching every consumer. This file just re-exports
 * the stable surface used by:
 *   - hooks/use-realtime-voice.ts (VoiceSessionManager)
 *   - systems/voice/VoiceRuntimeRoot.tsx
 *
 * Imports that referenced this module continue to work unchanged.
 */

export {
  RealtimeVoiceSession,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "./realtime/voice-session";
