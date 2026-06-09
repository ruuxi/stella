import { useEffect } from "react";
import { showToast } from "@/ui/toast";
import { resolveVoiceErrorToast } from "@/features/voice/runtime/voice-error-toast";

/**
 * The realtime voice runtime runs in the hidden overlay window, so it can't
 * surface its own user-visible toast. It forwards actionable session errors
 * (not signed in, provider not connected) to the main process, which routes
 * them to the visible app window. This listener — mounted in the full/mini
 * renderer — turns that into a real toast with a working sign-in / settings
 * CTA.
 */
export function VoiceErrorToastListener() {
  useEffect(() => {
    const off = window.electronAPI?.voice?.onSessionError?.((message) => {
      const toast = resolveVoiceErrorToast(message);
      if (toast) {
        showToast(toast);
      }
    });
    return () => {
      off?.();
    };
  }, []);

  return null;
}
