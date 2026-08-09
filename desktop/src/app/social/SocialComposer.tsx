import { useState, useRef, useCallback } from "react";
import { ArrowUp } from "@/ui/icons";

type SocialComposerProps = {
  onSend: (body: string) => void;
  /** When true, renders the Stella chip and accent tint (armed-for-Stella). */
  armed?: boolean;
  /** Override the default placeholder. */
  placeholder?: string;
};

export function SocialComposer({
  onSend,
  armed = false,
  placeholder,
}: SocialComposerProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setMessage("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [message, onSend]);

  const resolvedPlaceholder =
    placeholder ?? (armed ? "Tell Stella what you want..." : "Write a message...");

  return (
    <div className="social-composer">
      <div className="social-composer-input-wrap" data-armed={armed || undefined}>
        {armed && (
          <span className="social-composer-stella-chip">
            <img
              src="stella-logo.png"
              alt=""
              className="social-composer-stella-chip-logo"
            />
            Stella
          </span>
        )}
        <textarea
          ref={textareaRef}
          className="social-composer-input"
          placeholder={resolvedPlaceholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
        />
        <button
          type="button"
          className="social-composer-send"
          data-armed={armed || undefined}
          disabled={!message.trim()}
          onClick={handleSend}
          aria-label={armed ? "Tell Stella" : "Send"}
        >
          <ArrowUp size={14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
