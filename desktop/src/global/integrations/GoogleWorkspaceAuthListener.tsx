import { useEffect } from "react";
import { setGoogleWorkspaceAuthRequired } from "./google-workspace-auth-state";

/**
 * App-level passive listener for `googleWorkspace:authRequired` IPC events.
 *
 * Mount this once at the App root so the listener is attached for the entire
 * lifetime of the renderer — same rationale as `CredentialRequestLayer`. The
 * actual UI surface (the connect card) lives inside `ConversationEvents` and
 * reads the flag via `useGoogleWorkspaceAuthRequired`.
 */
export function GoogleWorkspaceAuthListener() {
  useEffect(() => {
    const api = window.electronAPI?.googleWorkspace;
    if (!api?.onAuthRequired) return;
    return api.onAuthRequired(() => {
      setGoogleWorkspaceAuthRequired();
    });
  }, []);

  return null;
}
