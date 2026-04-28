import { useState, useRef, useCallback } from "react";

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
              src="stella-logo.svg"
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
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
