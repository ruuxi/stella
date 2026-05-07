import { FileText, X } from "lucide-react";
import {
  ComposerStopButton,
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import { storeSidePanelStore } from "../store-side-panel-store";
import type { StoreThreadMessage } from "./types";

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
  return (
    <div className="chat-sidebar-composer">
      <div className="chat-sidebar-shell">
        <div className="chat-sidebar-shell-content">
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
            className="chat-sidebar-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSend();
            }}
          >
            <ComposerTextarea
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
              onChange={(event) => setComposer(event.target.value)}
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
