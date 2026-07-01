import { useCallback, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import "./CodexEngineNoticeDialog.css";

/**
 * Fired by an engine picker when the user selects the Codex engine. The
 * dialog lives at the app root (see `__root.tsx`) rather than inside a
 * picker so it survives the picker's own lifecycle — the sidebar model
 * picker is a Radix popover that dismisses the moment the dialog steals
 * focus, which would otherwise unmount an in-place dialog immediately.
 */
export const CODEX_ENGINE_NOTICE_EVENT = "stella:codex-engine-notice";

const PREFS_CHANGED_EVENT = "stella:local-model-preferences-changed";

declare global {
  interface WindowEventMap {
    [CODEX_ENGINE_NOTICE_EVENT]: CustomEvent<void>;
  }
}

/**
 * Informational dialog shown when the user selects the Codex engine.
 *
 * Codex is unlike the other engines: Stella herself keeps running on the
 * default engine and only the background agents she spawns run on Codex.
 * This sets expectations so the user isn't confused that the main chat
 * behaves as normal. A single "Got it" acknowledges the notice and applies
 * the switch; dismissing it (escape / scrim) leaves the engine unchanged.
 *
 * Matches the canonical dialog chrome (glass surface, display-font title,
 * pill button) used by the other Stella dialogs.
 */
export function CodexEngineNoticeDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onNotice = () => {
      setError(null);
      setOpen(true);
    };
    window.addEventListener(CODEX_ENGINE_NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(CODEX_ENGINE_NOTICE_EVENT, onNotice);
  }, []);

  const onCancel = useCallback(() => {
    if (busy) return;
    setOpen(false);
    setError(null);
  }, [busy]);

  const onConfirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI?.system?.setLocalModelPreferences?.({
        agentRuntimeEngine: "codex_cli",
      });
      window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT));
      setOpen(false);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message.trim()
          ? caught.message
          : "Failed to switch to the Codex engine.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent fit className="codex-engine-notice-dialog">
        <DialogHeader>
          <DialogTitle>Codex powers your agents, not Stella</DialogTitle>
          <DialogDescription>
            Heads up — Codex works a little differently from the other engines.
            Stella, the assistant you&rsquo;re chatting with, keeps running on
            the default engine. When you select Codex, it powers the agents
            Stella spawns to carry out tasks in the background. Your conversation
            with Stella won&rsquo;t change; the hands-on work just gets handled by
            Codex under the hood.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="codex-engine-notice-dialog-body">
          {error ? (
            <p className="codex-engine-notice-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="codex-engine-notice-actions">
            <Button
              type="button"
              variant="primary"
              className="pill-btn pill-btn--primary"
              onClick={() => void onConfirm()}
              disabled={busy}
              autoFocus
            >
              {busy ? "Switching…" : "Got it"}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ask the root-mounted `CodexEngineNoticeDialog` to explain the Codex engine
 * before the switch is applied. Engine pickers call this instead of writing
 * the preference directly when the user selects Codex.
 */
export function requestCodexEngineNotice(): void {
  window.dispatchEvent(new CustomEvent(CODEX_ENGINE_NOTICE_EVENT));
}
