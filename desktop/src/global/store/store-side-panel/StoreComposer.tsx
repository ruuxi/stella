import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import {
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import {
  claimDictationComposer,
  releaseDictationComposer,
} from "@/features/dictation/active-composer";
import { storeSidePanelStore } from "../store-side-panel-store";
import type { StoreThreadMessage } from "./types";

const STORE_COMPOSER_DICTATION_ID = "store-side-panel";

type StoreComposerProps = {
  composer: string;
  setComposer: (value: string) => void;
  selectedFeatureNames: ReadonlySet<string>;
  editingBlueprintMessage: StoreThreadMessage | null;
  onClearEditing: () => void;
  sending: boolean;
  isInFlight: boolean;
  stopping: boolean;
  onSend: () => void;
  onStop: () => void;
};

export function StoreComposer({
  composer,
  setComposer,
  selectedFeatureNames,
  editingBlueprintMessage,
  onClearEditing,
  sending,
  isInFlight,
  stopping,
  onSend,
  onStop,
}: StoreComposerProps) {
  const showChips = selectedFeatureNames.size > 0 || !!editingBlueprintMessage;
  const [expanded, setExpanded] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useAnimatedComposerShell({
    active: true,
    shellRef,
    contentRef: shellContentRef,
    formRef,
    syncOnNextFrame: true,
  });

  // Route dictation hotkey + sound effects to this composer while its
  // textarea is focused. The chat / sidebar composers default to
  // claim-less behaviour (`useDictation` without a `claimId`), so they
  // only respond when nobody has claimed dictation.
  useDictation({
    message: composer,
    setMessage: (next) =>
      setComposer(typeof next === "function" ? next(composer) : next),
    disabled: sending || isInFlight,
    claimId: STORE_COMPOSER_DICTATION_ID,
    onTranscriptCommitted: () => {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    },
  });

  // Release the claim if the parent unmounts mid-recording — keeps the
  // chat composer from getting stuck unable to respond to the hotkey.
  useEffect(() => {
    return () => releaseDictationComposer(STORE_COMPOSER_DICTATION_ID);
  }, []);

  // Collapse the shell back to a pill once the composer has been cleared
  // (e.g. after a successful send), matching the chat-sidebar pattern.
  useEffect(() => {
    if (composer === "") setExpanded(false);
  }, [composer]);

  return (
    <div className="chat-sidebar-composer">
      <div ref={shellRef} className="chat-sidebar-shell">
        <div ref={shellContentRef} className="chat-sidebar-shell-content">
          {showChips ? (
            <div className="composer-attached-strip composer-attached-strip--mini">
              {editingBlueprintMessage ? (
                <button
                  type="button"
                  className="store-side-panel-edit-chip"
                  onClick={onClearEditing}
                  title="Click to drop the edit reference"
                >
                  <FileText size={12} />
                  <span>Editing blueprint</span>
                  <X size={12} />
                </button>
              ) : null}
              {Array.from(selectedFeatureNames).map((name) => (
                <button
                  key={name}
                  type="button"
                  className="store-side-panel-edit-chip"
                  onClick={() => storeSidePanelStore.toggleFeature(name)}
                  title="Click to remove"
                >
                  <span>{name}</span>
                  <X size={12} />
                </button>
              ))}
            </div>
          ) : null}
          <form
            ref={formRef}
            className={`chat-sidebar-form${expanded ? " expanded" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              onSend();
            }}
          >
            <ComposerTextarea
              ref={inputRef}
              className="chat-sidebar-input"
              tone="default"
              value={composer}
              rows={1}
              placeholder={
                editingBlueprintMessage
                  ? "Describe the change you want to the draft…"
                  : "What do you want to publish?"
              }
              disabled={sending || isInFlight}
              onFocus={() => claimDictationComposer(STORE_COMPOSER_DICTATION_ID)}
              onBlur={() => releaseDictationComposer(STORE_COMPOSER_DICTATION_ID)}
              onChange={(event) => {
                setComposer(event.target.value);
                requestAnimationFrame(() => {
                  updateComposerTextareaExpansion(
                    inputRef.current,
                    setExpanded,
                  );
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSend();
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-toolbar-left" />
              <div className="composer-toolbar-right">
                {isInFlight ? (
                  <ComposerStopButton
                    className="composer-stop"
                    onClick={onStop}
                    disabled={stopping}
                    title="Stop"
                    aria-label="Stop"
                  />
                ) : (
                  <ComposerSubmitButton
                    className="composer-submit"
                    disabled={sending || !composer.trim()}
                    animated
                  />
                )}
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
