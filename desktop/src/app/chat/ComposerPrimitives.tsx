import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/utils";
import "./composer-primitives.css";

type ComposerFieldTone = "default" | "orb";

type ComposerButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  className?: string;
};

type ComposerFieldProps = {
  className?: string;
  tone?: ComposerFieldTone;
};

function AddIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
    >
      <line x1="12" y1="6" x2="12" y2="18" />
      <line x1="6" y1="12" x2="18" y2="12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function SpinnerIcon() {
  // Three-quarter ring on top of a faint full ring so rotation reads
  // unambiguously regardless of background contrast.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      className="chat-composer-spinner-svg"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

function SendIcon() {
  return (
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
  );
}

export const ComposerAddButton = forwardRef<HTMLButtonElement, ComposerButtonProps>(
  function ComposerAddButton({ className, children, onClick, disabled, ...props }, ref) {
    const isDisabled = disabled ?? !onClick;

    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "chat-composer-icon-button chat-composer-icon-button--add",
          className,
        )}
        onClick={onClick}
        disabled={isDisabled}
        {...props}
      >
        {children ?? <AddIcon />}
      </button>
    );
  },
);

export const ComposerStopButton = forwardRef<HTMLButtonElement, ComposerButtonProps>(
  function ComposerStopButton({ className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "chat-composer-icon-button chat-composer-icon-button--stop",
          className,
        )}
        {...props}
      >
        {children ?? <StopIcon />}
      </button>
    );
  },
);

type ComposerMicButtonProps = ComposerButtonProps & {
  /** During the brief upload window between stop and final transcript,
   *  the mic shows a subtle "transcribing" treatment. */
  isTranscribing?: boolean;
};

export const ComposerMicButton = forwardRef<
  HTMLButtonElement,
  ComposerMicButtonProps
>(function ComposerMicButton(
  { className, isTranscribing, children, title, ...props },
  ref,
) {
  const computedTitle =
    title ?? (isTranscribing ? "Transcribing…" : "Start dictation");
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "chat-composer-icon-button chat-composer-icon-button--mic",
        isTranscribing && "chat-composer-icon-button--mic-transcribing",
        className,
      )}
      title={computedTitle}
      aria-label={computedTitle}
      aria-busy={Boolean(isTranscribing)}
      {...props}
    >
      {children ?? (isTranscribing ? <SpinnerIcon /> : <MicIcon />)}
    </button>
  );
});

type ComposerSubmitButtonProps = ComposerButtonProps & {
  animated?: boolean;
};

export function ComposerSubmitButton({
  animated = false,
  className,
  children,
  disabled,
  ...props
}: ComposerSubmitButtonProps) {
  const sharedClassName = cn(
    "chat-composer-icon-button chat-composer-icon-button--submit",
    className,
  );

  if (animated) {
    const canSubmit = !disabled;
    // Motion reuses onDrag* for pan gestures; strip DOM drag handlers so types align.
    const {
      onDrag: _d0,
      onDragCapture: _d0c,
      onDragStart: _ds,
      onDragStartCapture: _dsc,
      onDragEnd: _de,
      onDragEndCapture: _dec,
      onAnimationStart: _as,
      onAnimationStartCapture: _asc,
      onAnimationEnd: _ae,
      onAnimationEndCapture: _aec,
      onAnimationIteration: _ai,
      onAnimationIterationCapture: _aic,
      ...motionButtonProps
    } = props;

    return (
      <motion.button
        type="submit"
        className={sharedClassName}
        disabled={disabled}
        animate={{
          opacity: canSubmit ? 1 : 0.4,
          scale: canSubmit ? 1 : 0.92,
        }}
        whileHover={canSubmit ? { opacity: 0.9 } : {}}
        transition={{ type: "spring", duration: 0.2, bounce: 0 }}
        {...motionButtonProps}
      >
        {children ?? <SendIcon />}
      </motion.button>
    );
  }

  return (
    <button
      type="submit"
      className={sharedClassName}
      disabled={disabled}
      {...props}
    >
      {children ?? <SendIcon />}
    </button>
  );
}

export const ComposerTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & ComposerFieldProps
>(function ComposerTextarea({ className, tone = "default", ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "chat-composer-field chat-composer-textarea",
        tone === "orb" && "chat-composer-field--orb",
        className,
      )}
      {...props}
    />
  );
});

export const ComposerTextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & ComposerFieldProps
>(function ComposerTextInput({ className, tone = "default", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "chat-composer-field chat-composer-text-input",
        tone === "orb" && "chat-composer-field--orb",
        className,
      )}
      {...props}
    />
  );
});
