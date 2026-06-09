import { showToast } from "@/ui/toast";
import {
  OPEN_SETTINGS_TOAST_ACTION,
  SIGN_IN_TOAST_ACTION,
} from "@/shared/lib/auth-cta";

/**
 * Realtime voice retries transient connection blips silently, so we only want
 * to interrupt the user with a toast when the failure is something *they* must
 * act on — they aren't signed in, or the chosen provider isn't connected.
 * These are the messages the voice backend raises (voice-handlers.ts), e.g.
 * "Connect OpenAI in Settings to use it for voice." Anything else stays silent
 * and rides the existing auto-retry.
 */
const VOICE_NEEDS_SIGN_IN = /sign[\s-]?in|not signed in|log[\s-]?in/i;
const VOICE_NEEDS_SETUP =
  /connect .* in settings|in settings|api key|not configured|no .* key|add .* key|unauthor|unauthenticated|\b401\b|\b403\b/i;

export const resolveVoiceErrorToast = (
  errorMessage: string | undefined,
): Parameters<typeof showToast>[0] | null => {
  const message = (errorMessage ?? "").trim();
  if (!message) return null;
  // Sign-in takes precedence: a 401 reads as "needs setup" too, but the
  // actionable fix for an unauthenticated user is signing in, not Settings.
  if (VOICE_NEEDS_SIGN_IN.test(message)) {
    return {
      title: "Sign in to use voice",
      description: message,
      variant: "error",
      duration: 8000,
      action: SIGN_IN_TOAST_ACTION,
    };
  }
  if (VOICE_NEEDS_SETUP.test(message)) {
    return {
      title: "Voice needs setup",
      description: message,
      variant: "error",
      duration: 8000,
      action: OPEN_SETTINGS_TOAST_ACTION,
    };
  }
  return null;
};
