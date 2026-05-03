import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";

const PLACEHOLDER = "Message Stella";

type PetChatPopoverProps = {
  /** When true the popover is rendered and auto-focuses the textarea. */
  open: boolean;
  /** Called after a non-empty submit. The pet overlay forwards the
   *  message through the `pet:sendMessage` IPC bridge so the full window
   *  can route it through the orchestrator. */
  onSubmit: (text: string) => void;
  /** Dismisses the popover (Escape, blur, or after submit). */
  onDismiss: () => void;
};

/**
 * Compact composer popover anchored to the left of the floating pet.
 *
 * The visual is intentionally a stripped-down version of the full chat
 * composer (`ComposerTextarea` + `ComposerSubmitButton` over the same
 * `chat-composer-*` styles) so the user sees the same input affordance
 * everywhere Stella runs. We do not bring chips/dictation/capture here
 * — the radial dial and full chat already own those flows; this surface
 * only needs "type a message, hit enter".
 */
export const PetChatPopover = ({
  open,
  onSubmit,
  onDismiss,
}: PetChatPopoverProps) => {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue("");
    // Focus on the next frame so the popover's transition has begun and
    // macOS doesn't swallow focus during the same tick the panel's
    // pointer-events flip on.
    const raf = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setValue("");
    onDismiss();
  }, [value, onSubmit, onDismiss]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    },
    [submit, onDismiss],
  );

  if (!open) return null;

  const canSubmit = value.trim().length > 0;

  return (
    <form
      className="pet-overlay-popover"
      onSubmit={handleSubmit}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="pet-overlay-popover-shell">
        <ComposerTextarea
          ref={textareaRef}
          value={value}
          placeholder={PLACEHOLDER}
          rows={2}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          aria-label="Message Stella from pet"
        />
        <ComposerSubmitButton
          animated
          aria-label="Send"
          disabled={!canSubmit}
        />
      </div>
    </form>
  );
};
