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
// Import the full chat composer's stylesheet so this popover renders
// pixel-identically — same shell, same form, same toolbar — to the
// composer the user already knows from the main window.
import "@/app/chat/full-shell.composer.css";

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
 * Visually identical to the full chat composer — same `composer-shell`
 * + `composer-form` container classes and the same `ComposerTextarea`
 * + `ComposerSubmitButton` primitives, so the user sees the same input
 * affordance everywhere Stella runs. We deliberately omit chips,
 * dictation, and the add menu: this surface only needs "type a
 * message, hit enter, fire & forget".
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
    // Focus on the next frame so the popover's transition has begun
    // and the pet `BrowserWindow` has finished flipping `focusable: true`
    // (driven by `pet:setComposerActive` in main).
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

  // Mirror the full composer's structure exactly so the same CSS
  // (`composer-shell`, `composer-form`, `composer-input`,
  // `composer-toolbar`, `composer-submit`) styles us identically.
  return (
    <div
      className="composer pet-overlay-popover"
      data-pet-hit="true"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="composer-shell">
        <div className="composer-shell-content">
          <form className="composer-form" onSubmit={handleSubmit}>
            <ComposerTextarea
              ref={textareaRef}
              className="composer-input"
              value={value}
              placeholder={PLACEHOLDER}
              rows={1}
              onChange={(event) => setValue(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              aria-label="Message Stella from pet"
            />
            <div className="composer-toolbar">
              <div className="composer-toolbar-left" />
              <div className="composer-toolbar-right">
                <ComposerSubmitButton
                  className="composer-submit"
                  animated
                  aria-label="Send"
                  disabled={!canSubmit}
                />
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
