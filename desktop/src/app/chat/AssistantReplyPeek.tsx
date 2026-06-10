import { X } from "@/ui/icons";
import "./assistant-reply-peek.css";

export type AssistantReplyPeekProps = {
  text: string;
  onJumpToBottom: () => void;
  onDismiss: () => void;
};

export function AssistantReplyPeek({
  text,
  onJumpToBottom,
  onDismiss,
}: AssistantReplyPeekProps) {
  return (
    <div className="assistant-reply-peek" role="status" aria-live="polite">
      <button
        type="button"
        className="assistant-reply-peek__body"
        onClick={onJumpToBottom}
        title="Jump to latest reply"
      >
        <span className="assistant-reply-peek__text">{text}</span>
      </button>
      <button
        type="button"
        className="assistant-reply-peek__dismiss"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss preview"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
