import { useEffect } from "react";
import { DICTATION_TOGGLE_EVENT } from "@/features/dictation/hooks/use-dictation";

/**
 * Global Cmd/Ctrl+Shift+M (or any dictation accelerator the user picks)
 * arrives here as an IPC signal from the focused window. Re-dispatch
 * as a window event so the active composer's `useDictation` hook can
 * toggle its STT session — this avoids each composer talking to IPC
 * directly.
 */
export function useDictationToggleBridge(): void {
  useEffect(() => {
    return window.electronAPI?.dictation?.onToggle((payload) => {
      window.dispatchEvent(
        new CustomEvent(DICTATION_TOGGLE_EVENT, {
          detail: payload,
        }),
      );
    });
  }, []);
}
